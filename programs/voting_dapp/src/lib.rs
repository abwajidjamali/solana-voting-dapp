#![allow(unexpected_cfgs)]
#![allow(deprecated)]

use anchor_lang::prelude::*;

declare_id!("9fRWQFyfPvsnrTNo6oYP3aZnu1rf13Wj4nb5qqc1o5YP");

#[program]
pub mod voting {
    use super::*;

    /// Initialize a new poll with candidates
    pub fn initialize_poll(
        ctx: Context<InitializePoll>,
        poll_id: u64,
        title: String,
        description: String,
        candidates: Vec<String>,
        start_time: i64,
        end_time: i64,
    ) -> Result<()> {
        require!(title.len() <= 100, VotingError::TitleTooLong);
        require!(description.len() <= 500, VotingError::DescriptionTooLong);
        require!(candidates.len() >= 2, VotingError::NotEnoughCandidates);
        require!(candidates.len() <= 10, VotingError::TooManyCandidates);
        require!(end_time > start_time, VotingError::InvalidTimeRange);

        let poll = &mut ctx.accounts.poll;
        poll.poll_id = poll_id;
        poll.authority = ctx.accounts.authority.key();
        poll.title = title;
        poll.description = description;
        poll.start_time = start_time;
        poll.end_time = end_time;
        poll.is_active = true;
        poll.total_votes = 0;

        poll.candidates = candidates
            .iter()
            .enumerate()
            .map(|(i, name)| {
                require!(name.len() <= 50, VotingError::CandidateNameTooLong);
                Ok(Candidate {
                    id: i as u8,
                    name: name.clone(),
                    vote_count: 0,
                })
            })
            .collect::<Result<Vec<Candidate>>>()?;

        msg!(
            "Poll '{}' created with {} candidates",
            poll.title,
            poll.candidates.len()
        );
        Ok(())
    }

    /// Cast a vote for a candidate in a poll
    pub fn cast_vote(ctx: Context<CastVote>, poll_id: u64, candidate_id: u8) -> Result<()> {
        let poll = &mut ctx.accounts.poll;
        let clock = Clock::get()?;
        let now = clock.unix_timestamp;

        require!(poll.is_active, VotingError::PollNotActive);
        require!(now >= poll.start_time, VotingError::PollNotStarted);
        require!(now <= poll.end_time, VotingError::PollEnded);
        require!(
            (candidate_id as usize) < poll.candidates.len(),
            VotingError::InvalidCandidate
        );

        let voter_record = &mut ctx.accounts.voter_record;
        voter_record.voter = ctx.accounts.voter.key();
        voter_record.poll_id = poll_id;
        voter_record.candidate_id = candidate_id;
        voter_record.timestamp = now;

        poll.candidates[candidate_id as usize].vote_count += 1;
        poll.total_votes += 1;

        msg!(
            "Vote cast by {} for candidate '{}' in poll '{}'",
            ctx.accounts.voter.key(),
            poll.candidates[candidate_id as usize].name,
            poll.title
        );
        Ok(())
    }

    /// Close a poll (authority only)
    pub fn close_poll(ctx: Context<ClosePoll>, _poll_id: u64) -> Result<()> {
        let poll = &mut ctx.accounts.poll;
        require!(poll.is_active, VotingError::PollAlreadyClosed);
        poll.is_active = false;
        msg!(
            "Poll '{}' closed. Total votes: {}",
            poll.title,
            poll.total_votes
        );
        Ok(())
    }

    /// Reopen a poll (authority only, only if not past end_time)
    pub fn reopen_poll(ctx: Context<ClosePoll>, _poll_id: u64) -> Result<()> {
        let poll = &mut ctx.accounts.poll;
        let clock = Clock::get()?;
        require!(!poll.is_active, VotingError::PollNotClosed);
        require!(
            clock.unix_timestamp <= poll.end_time,
            VotingError::PollEnded
        );
        poll.is_active = true;
        msg!("Poll '{}' has been reopened.", poll.title);
        Ok(())
    }
}

// ─── Accounts ────────────────────────────────────────────────────────────────

#[derive(Accounts)]
#[instruction(poll_id: u64)]
pub struct InitializePoll<'info> {
    #[account(
        init,
        payer = authority,
        space = Poll::SPACE,
        seeds = [b"poll", authority.key().as_ref(), &poll_id.to_le_bytes()],
        bump
    )]
    pub poll: Account<'info, Poll>,

    #[account(mut)]
    pub authority: Signer<'info>,

    pub system_program: Program<'info, System>,
}

#[derive(Accounts)]
#[instruction(poll_id: u64, candidate_id: u8)]
pub struct CastVote<'info> {
    #[account(
        mut,
        seeds = [b"poll", poll.authority.as_ref(), &poll_id.to_le_bytes()],
        bump
    )]
    pub poll: Account<'info, Poll>,

    /// One VoterRecord per (voter, poll) — prevents double voting
    #[account(
        init,
        payer = voter,
        space = VoterRecord::SPACE,
        seeds = [b"voter", voter.key().as_ref(), &poll_id.to_le_bytes()],
        bump
    )]
    pub voter_record: Account<'info, VoterRecord>,

    #[account(mut)]
    pub voter: Signer<'info>,

    pub system_program: Program<'info, System>,
}

#[derive(Accounts)]
#[instruction(poll_id: u64)]
pub struct ClosePoll<'info> {
    #[account(
        mut,
        seeds = [b"poll", authority.key().as_ref(), &poll_id.to_le_bytes()],
        bump,
        has_one = authority @ VotingError::Unauthorized
    )]
    pub poll: Account<'info, Poll>,

    pub authority: Signer<'info>,
}

// ─── State ───────────────────────────────────────────────────────────────────

#[account]
pub struct Poll {
    pub poll_id: u64,
    pub authority: Pubkey,
    pub title: String,
    pub description: String,
    pub candidates: Vec<Candidate>,
    pub start_time: i64,
    pub end_time: i64,
    pub is_active: bool,
    pub total_votes: u64,
}

impl Poll {
    pub const SPACE: usize = 8          // discriminator
        + 8        // poll_id
        + 32       // authority
        + 4 + 100  // title (len prefix + max bytes)
        + 4 + 500  // description
        + 4 + (10 * (1 + 4 + 50 + 8)) // candidates vec: max 10, each = id + name + vote_count
        + 8        // start_time
        + 8        // end_time
        + 1        // is_active
        + 8; // total_votes
}

#[derive(AnchorSerialize, AnchorDeserialize, Clone)]
pub struct Candidate {
    pub id: u8,
    pub name: String,
    pub vote_count: u64,
}

#[account]
pub struct VoterRecord {
    pub voter: Pubkey,
    pub poll_id: u64,
    pub candidate_id: u8,
    pub timestamp: i64,
}

impl VoterRecord {
    pub const SPACE: usize = 8 + 32 + 8 + 1 + 8;
}

// ─── Errors ──────────────────────────────────────────────────────────────────

#[error_code]
pub enum VotingError {
    #[msg("Poll title must be 100 characters or fewer")]
    TitleTooLong,
    #[msg("Poll description must be 500 characters or fewer")]
    DescriptionTooLong,
    #[msg("At least 2 candidates are required")]
    NotEnoughCandidates,
    #[msg("A poll can have at most 10 candidates")]
    TooManyCandidates,
    #[msg("Candidate name must be 50 characters or fewer")]
    CandidateNameTooLong,
    #[msg("end_time must be after start_time")]
    InvalidTimeRange,
    #[msg("Poll is not active")]
    PollNotActive,
    #[msg("Poll has not started yet")]
    PollNotStarted,
    #[msg("Poll has ended")]
    PollEnded,
    #[msg("Candidate ID is out of range")]
    InvalidCandidate,
    #[msg("Only the poll authority can perform this action")]
    Unauthorized,
    #[msg("Poll is already closed")]
    PollAlreadyClosed,
    #[msg("Poll is not closed")]
    PollNotClosed,
}
