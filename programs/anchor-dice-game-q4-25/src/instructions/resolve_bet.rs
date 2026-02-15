use crate::{errors::DiceError, Bet};
use anchor_instruction_sysvar::Ed25519InstructionSignatures;
use anchor_lang::{
    prelude::*,
    system_program::{transfer, Transfer},
};
use solana_program::{
    ed25519_program,
    sysvar::instructions::{load_instruction_at_checked, ID as InstructionSysvarId},
    hash::hash
};

#[constant]
const HOUSE_FEE: u64 = 150; //basis

#[derive(Accounts)]
#[instruction()]
pub struct ResolveBet<'info> {
    #[account(mut)]
    pub house: Signer<'info>,
    #[account(
        mut,
        seeds = [b"vault", house.key().as_ref()],
        bump
    )]
    pub vault: SystemAccount<'info>,
    /// CHECK: the player
    #[account(mut)]
    pub player: UncheckedAccount<'info>,
    #[account(
        mut,
        close = player,
        has_one = player,
        seeds = [b"bet", vault.key().as_ref(), bet.seed.to_le_bytes().as_ref()],
        bump = bet.bump
    )]
    pub bet: Account<'info, Bet>,
    /// CHECK: instructions sysvar
    #[account(
        address = InstructionSysvarId
    )]
    pub instructions: UncheckedAccount<'info>,
    pub system_program: Program<'info, System>,
}

impl<'info> ResolveBet<'info> {
    pub fn verify_ed25519_signature(&self, sig: &[u8]) -> Result<()> {
        let ed25519_ix = load_instruction_at_checked(0, &self.instructions)?;
        require_eq!(
            ed25519_ix.program_id,
            ed25519_program::ID,
            DiceError::Ed25519Program
        );
        require_eq!(ed25519_ix.accounts.len(), 0, DiceError::Ed25519Accounts);

        let signatures = Ed25519InstructionSignatures::unpack(&ed25519_ix.data)
            .map_err(|_| DiceError::Ed25519DataLength)?
            .0;
        require_eq!(signatures.len(), 1, DiceError::Ed25519Signature);

        let signature = &signatures[0];
        require!(signature.is_verifiable, DiceError::Ed25519Header);
        require_keys_eq!(
            signature.public_key.ok_or(DiceError::Ed25519Pubkey)?,
            self.player.key(),
            DiceError::Ed25519Pubkey
        );
        require!(
            &signature
                .signature
                .ok_or(DiceError::Ed25519Signature)?
                .eq(sig),
            DiceError::Ed25519Signature
        );
        require!(
            &signature
                .message
                .as_ref()
                .ok_or(DiceError::Ed25519Message)?
                .eq(&self.bet.to_slice()),
            DiceError::Ed25519Message
        );

        Ok(())
    }

    pub fn resolve_bet(&self, sig: &[u8], bumps: &ResolveBetBumps) -> Result<()> {
        let hash = hash(sig).to_bytes();

        let mut buffer = [0u8; 16];
        buffer.copy_from_slice(&hash[..16]);

        let lower = u128::from_le_bytes(buffer);
        buffer.copy_from_slice(&hash[16..]);

        let upper = u128::from_le_bytes(buffer);

        let roll = (lower.wrapping_add(upper).wrapping_rem(100) + 1) as u8;

        if self.bet.roll >= roll {
            let payout = self
                .bet
                .amount
                .checked_mul(10_000 - HOUSE_FEE)
                .ok_or(DiceError::Overflow)?
                .checked_div(10_000)
                .unwrap();
            let signer_seeds: &[&[&[u8]]] =
                &[&[b"vault", &self.house.key().to_bytes(), &[bumps.vault]]];

            let cpi_context = CpiContext::new_with_signer(
                self.system_program.to_account_info(),
                Transfer {
                    from: self.vault.to_account_info(),
                    to: self.player.to_account_info(),
                },
                signer_seeds,
            );

            transfer(cpi_context, payout)?;
        }
        Ok(())
    }
}