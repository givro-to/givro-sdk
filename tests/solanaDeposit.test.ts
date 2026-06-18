import { describe, expect, it } from "vitest";
import { Keypair, PublicKey } from "@solana/web3.js";
import { buildSolanaAttestedDepositTransaction } from "../src/solana/prepareSolanaDeposit.js";
import { vaultAtaPda } from "../src/solana/pda.js";

function u8(byte: number): Uint8Array {
  return new Uint8Array(32).fill(byte);
}

describe("buildSolanaAttestedDepositTransaction", () => {
  it("builds single-instruction SPL deposit and includes ATA bootstrap accounts", async () => {
    const programId = new PublicKey("8zsFkQmBTYQxWyeaGdrSjRtH8amuAnjtkqbLMMwowAJL");
    const payer = Keypair.generate().publicKey;
    const mint = new PublicKey("So11111111111111111111111111111111111111112");
    const paymentRef = u8(0xab);
    const tx = await buildSolanaAttestedDepositTransaction(null, {
      programId,
      payer,
      recentBlockhash: "11111111111111111111111111111111",
      order: {
        paymentRef,
        idHash: u8(0xcd),
        mint,
        amount: 1_000_000n,
        cancelBefore: 1n,
        claimBefore: 2n,
        refundAfter: 3n,
      },
    });

    const msg = tx.message;
    expect(msg.compiledInstructions).toHaveLength(1);
    const ix = msg.compiledInstructions[0];
    const keys = ix.accountKeyIndexes.map((idx) => msg.staticAccountKeys[idx].toBase58());
    expect(keys).toHaveLength(10);

    const expectedVaultAta = vaultAtaPda(programId, paymentRef).toBase58();
    expect(keys).toContain(expectedVaultAta);
    expect(keys).toContain("TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA");
    expect(keys).toContain("11111111111111111111111111111111");
    expect(keys).toContain("SysvarRent111111111111111111111111111111111");
    expect(keys).toContain("ATokenGPvbdGVxr1b2hvZbsiqW5xWH25efTNsLJA8knL");
  });
});

