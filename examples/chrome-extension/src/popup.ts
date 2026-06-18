import {
  createPublicClient,
  createWalletClient,
  http,
  parseUnits,
  formatUnits,
  type Address,
  type Hex,
} from "viem";
import { privateKeyToAccount } from "viem/accounts";
import {
  buildEvmAttestedDepositRequest,
  buildEvmApproveRequest,
  buildEvmDepositRequest,
  isNativeEvmToken,
  type AttestedOrder,
} from "../../../src/evm/prepareEvmDeposit.js";

// ── Persisted settings ────────────────────────────────────────────────────

const KEYS = {
  rpc:      "hfi_rpc",
  portal:   "hfi_portal",
  chainId:  "hfi_chainid",
  contract: "hfi_contract",
  privKey:  "hfi_pk",
};

function load(key: string, fallback: string): string {
  return localStorage.getItem(key) ?? fallback;
}

function save(key: string, val: string): void {
  if (val.trim()) localStorage.setItem(key, val.trim());
}

// ── DOM refs ──────────────────────────────────────────────────────────────

const $ = <T extends HTMLElement>(id: string) => document.getElementById(id) as T;

const rpcInput       = $<HTMLInputElement>("rpcUrl");
const portalInput    = $<HTMLInputElement>("portalUrl");
const chainIdInput   = $<HTMLInputElement>("chainId");
const contractInput  = $<HTMLInputElement>("contractAddr");
const privKeyInput   = $<HTMLInputElement>("privKey");
const addressEl      = $("address");
const balanceEl      = $("balance");
const recipientKind  = $<HTMLSelectElement>("recipientKind");
const recipientInput = $<HTMLInputElement>("recipient");
const amountInput    = $<HTMLInputElement>("amount");
const tokenInput     = $<HTMLInputElement>("token");
const sendBtn        = $<HTMLButtonElement>("sendBtn");
const statusEl       = $("status");
const settingsToggle = $("settingsToggle");
const settingsPanel  = $("settings");

// ── Init ──────────────────────────────────────────────────────────────────

rpcInput.value      = load(KEYS.rpc,      "http://localhost:9545");
portalInput.value   = load(KEYS.portal,   "http://localhost:3100");
chainIdInput.value  = load(KEYS.chainId,  "31337");
contractInput.value = load(KEYS.contract, "");
privKeyInput.value  = load(KEYS.privKey,  "");

settingsToggle.addEventListener("click", () => {
  settingsPanel.classList.toggle("open");
});

[rpcInput, portalInput, chainIdInput, contractInput, privKeyInput].forEach((el) => {
  el.addEventListener("change", () => {
    save(KEYS.rpc,      rpcInput.value);
    save(KEYS.portal,   portalInput.value);
    save(KEYS.chainId,  chainIdInput.value);
    save(KEYS.contract, contractInput.value);
    save(KEYS.privKey,  privKeyInput.value);
    void refresh();
  });
});

// ── Status helpers ────────────────────────────────────────────────────────

function showStatus(msg: string, kind: "ok" | "err" | "info") {
  statusEl.textContent = msg;
  statusEl.className = `status ${kind}`;
}

function clearStatus() { statusEl.className = "status"; }

// ── Chain / account setup ─────────────────────────────────────────────────

const NATIVE_DECIMALS = 18;
const NATIVE_SYMBOL   = "GO";

function getClients() {
  const rpc = rpcInput.value.trim() || "http://localhost:9545";
  const pk  = privKeyInput.value.trim() as Hex;
  if (!pk || !pk.startsWith("0x") || pk.length < 10) return null;
  const chainId = Number(chainIdInput.value.trim()) || 31337;
  const account = privateKeyToAccount(pk);
  const transport = http(rpc);
  const chain = {
    id: chainId,
    name: "Local",
    nativeCurrency: { name: NATIVE_SYMBOL, symbol: NATIVE_SYMBOL, decimals: NATIVE_DECIMALS },
    rpcUrls: { default: { http: [rpc] } },
  } as const;
  const publicClient = createPublicClient({ chain, transport });
  const walletClient = createWalletClient({ account, chain, transport });
  return { publicClient, walletClient, account, chain };
}

async function refresh() {
  const ctx = getClients();
  if (!ctx) {
    addressEl.textContent = "Enter private key in settings";
    balanceEl.textContent = "—";
    sendBtn.disabled = true;
    return;
  }
  addressEl.textContent = ctx.account.address;
  balanceEl.textContent = "…";
  try {
    const bal = await ctx.publicClient.getBalance({ address: ctx.account.address });
    balanceEl.textContent = `${formatUnits(bal, NATIVE_DECIMALS)} ${NATIVE_SYMBOL}`;
    sendBtn.disabled = false;
  } catch (e) {
    balanceEl.textContent = "RPC error";
    console.error(e);
  }
}

// ── Send ──────────────────────────────────────────────────────────────────

sendBtn.addEventListener("click", () => void handleSend());

async function handleSend() {
  clearStatus();
  const ctx = getClients();
  if (!ctx) { showStatus("Enter your private key in settings.", "err"); return; }

  const portal   = portalInput.value.trim().replace(/\/$/, "") || "http://localhost:3100";
  const chainId  = Number(chainIdInput.value.trim()) || 31337;
  const token    = tokenInput.value.trim() || "GO";
  const kind     = recipientKind.value as "email" | "x" | "phone";
  const recipient = recipientInput.value.trim();
  const amount   = amountInput.value.trim();

  if (!recipient) { showStatus("Enter a recipient.", "err"); return; }
  if (!amount || isNaN(Number(amount)) || Number(amount) <= 0) {
    showStatus("Enter a valid amount.", "err");
    return;
  }

  sendBtn.disabled = true;
  showStatus("Getting quote…", "info");

  try {
    const amountWei = parseUnits(amount, NATIVE_DECIMALS).toString();

    // ── 1. Quote ──────────────────────────────────────────────────────────
    const identifier = kind === "x" ? recipient.replace(/^@/, "") : recipient;
    const quoteRes = await fetch(`${portal}/api/portal/v1/quote`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        identifier,
        identifierKind: kind,
        amountWei,
        token,
        vm: "evm",
        chainId,
      }),
    });
    if (!quoteRes.ok) {
      const err = await quoteRes.json().catch(() => ({})) as { error?: string };
      throw new Error(`Quote failed: ${err.error ?? quoteRes.statusText}`);
    }
    const q = await quoteRes.json() as {
      paymentRef: Hex;
      order?: {
        chainId: number;
        paymentRef: Hex;
        idHash: Hex;
        token: Address;
        amount: string;
        cancelBefore: string;
        claimBefore: string;
        refundAfter: string;
      };
      attestedContract?: Address;
      depositContract?: Address;
    };

    // ── 2. Deposit transaction ────────────────────────────────────────────
    showStatus("Sending deposit transaction…", "info");

    const depositContract = ((q.attestedContract ?? q.depositContract ?? contractInput.value.trim()) || "") as Address;
    if (!depositContract || !depositContract.startsWith("0x")) {
      throw new Error("No deposit contract address — set one in Settings or ensure the quote returns attestedContract.");
    }

    let txHash: Hex;
    if (q.order && q.attestedContract) {
      // Attested flow (permissionless — no portal signature required)
      const idHash = typeof q.order.idHash === "string" ? (q.order.idHash as Hex) : undefined;
      if (!idHash) {
        throw new Error("Attested quote missing order.idHash");
      }
      const order: AttestedOrder = {
        chainId: BigInt(q.order.chainId),
        paymentRef: q.order.paymentRef as Hex,
        idHash,
        token: q.order.token as Address,
        amount: BigInt(q.order.amount),
        cancelBefore: BigInt(q.order.cancelBefore),
        claimBefore: BigInt(q.order.claimBefore),
        refundAfter: BigInt(q.order.refundAfter),
      };
      const tokenAddr = order.token;
      if (!isNativeEvmToken(tokenAddr)) {
        const approve = buildEvmApproveRequest({ token: tokenAddr, depositContract, amount: order.amount });
        showStatus("Approving ERC-20…", "info");
        await ctx.walletClient.sendTransaction({ to: approve.to, data: approve.data as Hex, value: approve.value });
      }
      const deposit = buildEvmAttestedDepositRequest({ depositContract: q.attestedContract, order });
      showStatus("Sending deposit…", "info");
      txHash = await ctx.walletClient.sendTransaction({ to: deposit.to, data: deposit.data as Hex, value: deposit.value });
    } else {
      // Legacy deposit flow
      const tokenAddr = (q.order?.token ?? "0x0000000000000000000000000000000000000000") as Address;
      const depositAmt = BigInt(q.order?.amount ?? amountWei);
      if (!isNativeEvmToken(tokenAddr)) {
        const approve = buildEvmApproveRequest({ token: tokenAddr, depositContract, amount: depositAmt });
        showStatus("Approving ERC-20…", "info");
        await ctx.walletClient.sendTransaction({ to: approve.to, data: approve.data as Hex, value: approve.value });
      }
      const deposit = buildEvmDepositRequest({ depositContract, paymentRef: q.paymentRef, token: tokenAddr, amount: depositAmt });
      showStatus("Sending deposit…", "info");
      txHash = await ctx.walletClient.sendTransaction({ to: deposit.to, data: deposit.data as Hex, value: deposit.value });
    }

    const claimUrl = `${portal}/claim?ref=${encodeURIComponent(q.paymentRef)}`;
    showStatus(`✓ Sent!\nTx: ${txHash}\nClaim: ${claimUrl}`, "ok");
    void refresh();
  } catch (e: unknown) {
    const msg = e instanceof Error ? e.message : String(e);
    showStatus(`Error: ${msg}`, "err");
  } finally {
    sendBtn.disabled = false;
  }
}

// ── Bootstrap ─────────────────────────────────────────────────────────────

recipientKind.addEventListener("change", () => {
  const v = recipientKind.value;
  if (v === "x") {
    recipientInput.placeholder = "@alice";
  } else if (v === "phone") {
    recipientInput.placeholder = "+1234567890";
  } else {
    recipientInput.placeholder = "alice@example.com";
  }
});

void refresh();
