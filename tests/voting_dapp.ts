import * as anchor from "@coral-xyz/anchor";
import { Program, BN } from "@coral-xyz/anchor";
import { Voting } from "../target/types/voting_dapp";
import { Keypair, PublicKey, SystemProgram } from "@solana/web3.js";
import { expect } from "chai";

describe("voting", () => {
  const provider = anchor.AnchorProvider.env();
  anchor.setProvider(provider);
  const program = anchor.workspace.Voting as Program<Voting>;
  const authority = provider.wallet as anchor.Wallet;

  const now = () => Math.floor(Date.now() / 1000);

  function pollPDA(pollId: BN, auth: PublicKey = authority.publicKey) {
    return PublicKey.findProgramAddressSync(
      [Buffer.from("poll"), auth.toBuffer(), pollId.toArrayLike(Buffer, "le", 8)],
      program.programId
    );
  }

  function voterPDA(voter: PublicKey, pollId: BN) {
    return PublicKey.findProgramAddressSync(
      [Buffer.from("voter"), voter.toBuffer(), pollId.toArrayLike(Buffer, "le", 8)],
      program.programId
    );
  }

  async function createPoll(pollId: BN, overrides: Partial<{
    title: string; description: string; candidates: string[];
    startOffset: number; endOffset: number;
  }> = {}) {
    const {
      title = "Test Poll", description = "A test poll",
      candidates = ["Alice", "Bob", "Charlie"],
      startOffset = -10, endOffset = 3600,
    } = overrides;
    const [pollAccount] = pollPDA(pollId);
    await program.methods
      .initializePoll(pollId, title, description, candidates,
        new BN(now() + startOffset), new BN(now() + endOffset))
      .accounts({ poll: pollAccount, authority: authority.publicKey, systemProgram: SystemProgram.programId })
      .rpc();
    return pollAccount;
  }

  async function vote(pollId: BN, candidateId: number, voterKeypair?: Keypair) {
    const [pollAccount] = pollPDA(pollId);
    if (voterKeypair) {
      const sig = await provider.connection.requestAirdrop(voterKeypair.publicKey, anchor.web3.LAMPORTS_PER_SOL);
      await provider.connection.confirmTransaction(sig);
      const [voterRecord] = voterPDA(voterKeypair.publicKey, pollId);
      await program.methods.castVote(pollId, candidateId)
        .accounts({ poll: pollAccount, voterRecord, voter: voterKeypair.publicKey, systemProgram: SystemProgram.programId })
        .signers([voterKeypair]).rpc();
      return voterRecord;
    } else {
      const [voterRecord] = voterPDA(authority.publicKey, pollId);
      await program.methods.castVote(pollId, candidateId)
        .accounts({ poll: pollAccount, voterRecord, voter: authority.publicKey, systemProgram: SystemProgram.programId })
        .rpc();
      return voterRecord;
    }
  }

  // ── 1. Initialization ─────────────────────────────────────────────────────

  describe("Poll Initialization", () => {
    it("creates a poll with correct state", async () => {
      const pollId = new BN(100);
      const pollAccount = await createPoll(pollId, {
        title: "Best Framework?", candidates: ["Anchor", "Seahorse", "Native"],
      });
      const poll = await program.account.poll.fetch(pollAccount);
      expect(poll.title).to.equal("Best Framework?");
      expect(poll.candidates).to.have.length(3);
      expect(poll.isActive).to.be.true;
      expect(poll.totalVotes.toNumber()).to.equal(0);
    });

    it("rejects fewer than 2 candidates", async () => {
      try {
        await createPoll(new BN(101), { candidates: ["Solo"] });
        expect.fail("should have thrown");
      } catch (err: any) {
        expect(err.error.errorCode.code).to.equal("NotEnoughCandidates");
      }
    });

    it("rejects a title longer than 100 chars", async () => {
      try {
        await createPoll(new BN(102), { title: "A".repeat(101) });
        expect.fail("should have thrown");
      } catch (err: any) {
        expect(err.error.errorCode.code).to.equal("TitleTooLong");
      }
    });

    it("rejects end_time before start_time", async () => {
      try {
        await createPoll(new BN(103), { startOffset: 100, endOffset: 50 });
        expect.fail("should have thrown");
      } catch (err: any) {
        expect(err.error.errorCode.code).to.equal("InvalidTimeRange");
      }
    });
  });

  // ── 2. Voting ─────────────────────────────────────────────────────────────

  describe("Voting", () => {
    const VOTE_POLL = new BN(200);
    before(async () => { await createPoll(VOTE_POLL, { candidates: ["Alice", "Bob"] }); });

    it("increments the correct candidate vote count", async () => {
      await vote(VOTE_POLL, 0, Keypair.generate());
      const [pollAccount] = pollPDA(VOTE_POLL);
      const poll = await program.account.poll.fetch(pollAccount);
      expect(poll.candidates[0].voteCount.toNumber()).to.equal(1);
      expect(poll.totalVotes.toNumber()).to.equal(1);
    });

    it("saves voter record with correct data", async () => {
      const voter = Keypair.generate();
      const voterRecord = await vote(VOTE_POLL, 1, voter);
      const record = await program.account.voterRecord.fetch(voterRecord);
      expect(record.voter.toBase58()).to.equal(voter.publicKey.toBase58());
      expect(record.candidateId).to.equal(1);
    });

    it("prevents double voting from same wallet", async () => {
      const voter = Keypair.generate();
      await vote(VOTE_POLL, 0, voter);
      try {
        await vote(VOTE_POLL, 1, voter);
        expect.fail("should have thrown");
      } catch (err: any) {
        expect(err.toString()).to.include("already in use");
      }
    });

    it("rejects an invalid candidate id", async () => {
      const voter = Keypair.generate();
      try {
        await vote(VOTE_POLL, 99, voter);
        expect.fail("should have thrown");
      } catch (err: any) {
        expect(err.error.errorCode.code).to.equal("InvalidCandidate");
      }
    });

    it("rejects votes on a poll that hasn't started", async () => {
      const pollId = new BN(201);
      await createPoll(pollId, { startOffset: 3600, endOffset: 7200 });
      try {
        await vote(pollId, 0, Keypair.generate());
        expect.fail("should have thrown");
      } catch (err: any) {
        expect(err.error.errorCode.code).to.equal("PollNotStarted");
      }
    });
  });

  // ── 3. Poll Management ────────────────────────────────────────────────────

  describe("Poll Management", () => {
    const MGMT_POLL = new BN(300);
    let pollAccount: PublicKey;
    before(async () => { pollAccount = await createPoll(MGMT_POLL); });

    it("authority can close a poll", async () => {
      await program.methods.closePoll(MGMT_POLL)
        .accounts({ poll: pollAccount, authority: authority.publicKey }).rpc();
      const poll = await program.account.poll.fetch(pollAccount);
      expect(poll.isActive).to.be.false;
    });

    it("rejects votes on a closed poll", async () => {
      try {
        await vote(MGMT_POLL, 0, Keypair.generate());
        expect.fail("should have thrown");
      } catch (err: any) {
        expect(err.error.errorCode.code).to.equal("PollNotActive");
      }
    });

    it("authority can reopen a closed poll", async () => {
      await program.methods.reopenPoll(MGMT_POLL)
        .accounts({ poll: pollAccount, authority: authority.publicKey }).rpc();
      const poll = await program.account.poll.fetch(pollAccount);
      expect(poll.isActive).to.be.true;
    });

    it("non-authority cannot close a poll", async () => {
      const attacker = Keypair.generate();
      const sig = await provider.connection.requestAirdrop(attacker.publicKey, anchor.web3.LAMPORTS_PER_SOL);
      await provider.connection.confirmTransaction(sig);
      try {
        await program.methods.closePoll(MGMT_POLL)
          .accounts({ poll: pollAccount, authority: attacker.publicKey })
          .signers([attacker]).rpc();
        expect.fail("should have thrown");
      } catch (err: any) {
        expect(err.error.errorCode.code).to.equal("ConstraintSeeds");
      }
    });
  });

  // ── 4. Results ────────────────────────────────────────────────────────────

  describe("Results", () => {
    const RESULT_POLL = new BN(400);
    let pollAccount: PublicKey;

    before(async () => {
      pollAccount = await createPoll(RESULT_POLL, { candidates: ["Red", "Blue", "Green"] });
      for (let i = 0; i < 3; i++) await vote(RESULT_POLL, 0, Keypair.generate()); // 3 for Red
      await vote(RESULT_POLL, 1, Keypair.generate());                              // 1 for Blue
      for (let i = 0; i < 2; i++) await vote(RESULT_POLL, 2, Keypair.generate()); // 2 for Green
    });

    it("reflects correct vote counts per candidate", async () => {
      const poll = await program.account.poll.fetch(pollAccount);
      expect(poll.candidates[0].voteCount.toNumber()).to.equal(3);
      expect(poll.candidates[1].voteCount.toNumber()).to.equal(1);
      expect(poll.candidates[2].voteCount.toNumber()).to.equal(2);
      expect(poll.totalVotes.toNumber()).to.equal(6);
    });

    it("correctly identifies the winner", async () => {
      const poll = await program.account.poll.fetch(pollAccount);
      const winner = poll.candidates.reduce((a, b) => a.voteCount > b.voteCount ? a : b);
      expect(winner.name).to.equal("Red");
    });
  });
});