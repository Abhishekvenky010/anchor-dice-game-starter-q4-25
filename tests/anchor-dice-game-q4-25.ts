import * as anchor from "@coral-xyz/anchor";
import { Program } from "@coral-xyz/anchor";
import { AnchorDice2026 } from "../target/types/anchor_dice_2026";     
import {
  PublicKey,
  Keypair,
  SystemProgram,
  LAMPORTS_PER_SOL,
  Ed25519Program,
  Transaction,
  sendAndConfirmTransaction,
} from "@solana/web3.js";
import { assert, expect } from "chai";

describe("anchor-dice-game-q4-25", () => {
  // Configure the client to use the local cluster.
  const provider = anchor.AnchorProvider.env();
  anchor.setProvider(provider);

  const program = anchor.workspace.anchorDiceGameQ425 as Program<AnchorDice2026>;

  const connection = provider.connection;

  console.log(program.programId.toBase58());
  const house = Keypair.generate();
  const player = Keypair.generate();

  let vault: PublicKey;

  before(async () => {
    const houseAirdrop = await connection.requestAirdrop(
      house.publicKey,
      10 * LAMPORTS_PER_SOL,
    );
    await connection.confirmTransaction(houseAirdrop);

    const playerAirdrop = await connection.requestAirdrop(
      player.publicKey,
      10 * LAMPORTS_PER_SOL,
    );
    await connection.confirmTransaction(playerAirdrop);

    [vault] = PublicKey.findProgramAddressSync(
      [Buffer.from("vault"), house.publicKey.toBytes()],
      program.programId,
    );
  });

  describe("Initialize", () => {
    it("Initializes the vault with funds", async () => {
      const amount = new anchor.BN(2 * LAMPORTS_PER_SOL);

      const sig = await program.methods
        .initialize(amount)
        .accountsStrict({
          house: house.publicKey,
          vault,
          systemProgram: SystemProgram.programId,
        })
        .signers([house])
        .rpc();

      console.log("Initialize tx:", sig);

      const vaultBalance = await connection.getBalance(vault);
      assert.equal(
        vaultBalance,
        2 * LAMPORTS_PER_SOL,
        "Vault should have 2 SOL",
      );
    });
  });

  describe("Place Bet", () => {
    const seed = new anchor.BN(1);
    const roll = 50;
    const amount = new anchor.BN(0.1 * LAMPORTS_PER_SOL);

    it("Places a bet successfully", async () => {
      const [betPda] = PublicKey.findProgramAddressSync(
        [
          Buffer.from("bet"),
          vault.toBytes(),
          seed.toArrayLike(Buffer, "le", 16),
        ],
        program.programId,
      );

      const vaultBalanceBefore = await connection.getBalance(vault);

      const sig = await program.methods
        .placeBet(seed, roll, amount)
        .accountsStrict({
          player: player.publicKey,
          house: house.publicKey,
          vault,
          bet: betPda,
          systemProgram: SystemProgram.programId,
        })
        .signers([player])
        .rpc();

      console.log("Place Bet tx:", sig);

      const betAccount = await program.account.bet.fetch(betPda);
      assert.equal(
        betAccount.player.toString(),
        player.publicKey.toString(),
        "Bet player should match",
      );
      assert.equal(
        betAccount.seed.toString(),
        seed.toString(),
        "Bet seed should match",
      );
      assert.equal(betAccount.roll, roll, "Bet roll should match");
      assert.equal(
        betAccount.amount.toString(),
        amount.toString(),
        "Bet amount should match",
      );

      const vaultBalanceAfter = await connection.getBalance(vault);
      assert.equal(
        vaultBalanceAfter - vaultBalanceBefore,
        amount.toNumber(),
        "Vault balance should increase by bet amount",
      );
    });
  });

  describe("Refund Bet", () => {
    const seed = new anchor.BN(99);
    const roll = 50;
    const amount = new anchor.BN(0.1 * LAMPORTS_PER_SOL);
    let betPda: PublicKey;

    before(async () => {
      [betPda] = PublicKey.findProgramAddressSync(
        [
          Buffer.from("bet"),
          vault.toBytes(),
          seed.toArrayLike(Buffer, "le", 16),
        ],
        program.programId,
      );

      await program.methods
        .placeBet(seed, roll, amount)
        .accountsStrict({
          player: player.publicKey,
          house: house.publicKey,
          vault,
          bet: betPda,
          systemProgram: SystemProgram.programId,
        })
        .signers([player])
        .rpc();
    });

    it("Fails to refund before timeout is reached", async () => {
      try {
        await program.methods
          .refundBet()
          .accountsStrict({
            player: player.publicKey,
            house: house.publicKey,
            vault,
            bet: betPda,
            systemProgram: SystemProgram.programId,
          })
          .signers([player])
          .rpc();
        assert.fail("Refund should fail - timeout not reached");
      } catch (err: any) {
        console.log("Refund correctly rejected before timeout");
      }
    });
  });

  describe("Resolve Bet", () => {
    const seed = new anchor.BN(100);
    const roll = 50;
    const amount = new anchor.BN(0.1 * LAMPORTS_PER_SOL);
    let betPda: PublicKey;
    const instructionSysvar = new PublicKey(
      "Sysvar1nstructions1111111111111111111111111",
    );

    before(async () => {
      [betPda] = PublicKey.findProgramAddressSync(
        [
          Buffer.from("bet"),
          vault.toBytes(),
          seed.toArrayLike(Buffer, "le", 16),
        ],
        program.programId,
      );

      await program.methods
        .placeBet(seed, roll, amount)
        .accountsStrict({
          player: player.publicKey,
          house: house.publicKey,
          vault,
          bet: betPda,
          systemProgram: SystemProgram.programId,
        })
        .signers([player])
        .rpc();
    });

    it("Resolves a bet correctly", async () => {
      const betAccountInfo = await connection.getAccountInfo(betPda);
      const betAccountBefore = await program.account.bet.fetch(betPda);

      const ed25519Ix = Ed25519Program.createInstructionWithPrivateKey({
        privateKey: player.secretKey,
        message: betAccountInfo.data.subarray(8),
      });

      const resolveIx = await program.methods
        .resolveBet(ed25519Ix.data.subarray(48, 112))
        .accountsStrict({
          player: player.publicKey,
          house: house.publicKey,
          vault,
          bet: betPda,
          instructions: instructionSysvar,
          systemProgram: SystemProgram.programId,
        })
        .instruction();

      const vaultBalanceBefore = await connection.getBalance(vault);
      const playerBalanceBefore = await connection.getBalance(player.publicKey);
      const betRentLamports = betAccountInfo.lamports;

      const tx = new Transaction().add(ed25519Ix).add(resolveIx);
      const sig = await sendAndConfirmTransaction(connection, tx, [house]);
      console.log("Resolve Bet tx:", sig);

      const closedBetAccount = await connection.getAccountInfo(betPda);

      expect(closedBetAccount.data.length).to.equal(
        0,
        "Bet account should be closed after resolution(data === 0)",
      );
      expect(closedBetAccount.lamports).to.equal(
        0,
        "Bet account should be closed after resolution(lamporsts === 0)",
      );

      const vaultBalanceAfter = await connection.getBalance(vault);
      const playerBalanceAfter = await connection.getBalance(player.publicKey);

      const playerBalanceChange = playerBalanceAfter - playerBalanceBefore;
      const vaultBalanceChange = vaultBalanceBefore - vaultBalanceAfter;

      if (vaultBalanceChange > 0) {
        // Player won
        const expectedPayout = Math.floor(
          (amount.toNumber() * (10_000 - 150)) / 10_000,
        );
        assert.equal(
          vaultBalanceChange,
          expectedPayout,
          "Vault should decrease by payout amount on win",
        );
        assert.equal(
          playerBalanceChange,
          betRentLamports + expectedPayout,
          "Player should receive rent + payout on win",
        );
        console.log(
          `Player won! Roll: ${betAccountBefore.roll}, Payout: ${
            expectedPayout / LAMPORTS_PER_SOL
          } SOL`,
        );
      } else {
        // Player lost
        assert.equal(
          vaultBalanceChange,
          0,
          "Vault balance should remain unchanged on loss",
        );
        assert.equal(
          playerBalanceChange,
          betRentLamports,
          "Player should only receive rent back on loss",
        );
        console.log(
          `Player lost. Roll: ${betAccountBefore.roll}, no payout from vault`,
        );
      }
    });
  });
});