/** ABI for the deployed `HfiPayDeposit` EVM contract. */
export const HFI_PAY_DEPOSIT_ABI = [
  {
    type: "function",
    name: "depositErc20",
    inputs: [
      { name: "paymentRef", type: "bytes32" },
      { name: "token", type: "address" },
      { name: "amount", type: "uint256" },
    ],
    outputs: [],
    stateMutability: "nonpayable",
  },
  {
    type: "function",
    name: "depositNative",
    inputs: [{ name: "paymentRef", type: "bytes32" }],
    outputs: [],
    stateMutability: "payable",
  },
] as const;

/** Common sentinel for "native gas token" in SDK helpers */
export const ZERO_ADDRESS = "0x0000000000000000000000000000000000000000" as const;

/** ABI for `HfiPayAttested` v2 — permissionless deposit, protocol fee. */
export const HFI_PAY_ATTESTED_V1_ABI = [
  {
    type: "function",
    name: "depositNativeWithOrder",
    inputs: [
      {
        name: "order_",
        type: "tuple",
        components: [
          { name: "chainId", type: "uint256" },
          { name: "paymentRef", type: "bytes32" },
          { name: "idHash", type: "bytes32" },
          { name: "token", type: "address" },
          { name: "amount", type: "uint256" },
          { name: "cancelBefore", type: "uint64" },
          { name: "claimBefore", type: "uint64" },
          { name: "refundAfter", type: "uint64" },
        ],
      },
      { name: "originRelay", type: "address" },
    ],
    outputs: [],
    stateMutability: "payable",
  },
  {
    type: "function",
    name: "depositErc20WithOrder",
    inputs: [
      {
        name: "order_",
        type: "tuple",
        components: [
          { name: "chainId", type: "uint256" },
          { name: "paymentRef", type: "bytes32" },
          { name: "idHash", type: "bytes32" },
          { name: "token", type: "address" },
          { name: "amount", type: "uint256" },
          { name: "cancelBefore", type: "uint64" },
          { name: "claimBefore", type: "uint64" },
          { name: "refundAfter", type: "uint64" },
        ],
      },
      { name: "originRelay", type: "address" },
    ],
    outputs: [],
    stateMutability: "nonpayable",
  },
  {
    type: "function",
    name: "cancelByPayer",
    inputs: [{ name: "paymentRef", type: "bytes32" }],
    outputs: [],
    stateMutability: "nonpayable",
  },
  {
    type: "function",
    name: "bind",
    stateMutability: "nonpayable",
    inputs: [
      {
        name: "m",
        type: "tuple",
        components: [
          { name: "idHash", type: "bytes32" },
          { name: "addr", type: "address" },
          { name: "issuedAt", type: "uint64" },
        ],
      },
      { name: "recipientSig", type: "bytes" },
      { name: "serverSig", type: "bytes" },
    ],
    outputs: [],
  },
  {
    type: "function",
    name: "revokePending",
    stateMutability: "nonpayable",
    inputs: [
      { name: "idHash", type: "bytes32" },
      { name: "nonce", type: "uint64" },
      { name: "deadline", type: "uint64" },
      { name: "sig", type: "bytes" },
    ],
    outputs: [],
  },
  {
    type: "function",
    name: "revokeNonce",
    stateMutability: "view",
    inputs: [{ name: "idHash", type: "bytes32" }],
    outputs: [{ type: "uint64" }],
  },
  {
    type: "function",
    name: "claim",
    stateMutability: "nonpayable",
    inputs: [{ name: "paymentRef", type: "bytes32" }],
    outputs: [],
  },
  {
    type: "function",
    name: "refund",
    stateMutability: "nonpayable",
    inputs: [{ name: "paymentRef", type: "bytes32" }],
    outputs: [],
  },
  {
    type: "function",
    name: "effectiveBinding",
    stateMutability: "view",
    inputs: [{ name: "idHash", type: "bytes32" }],
    outputs: [{ name: "", type: "address" }],
  },
  {
    type: "function",
    name: "bindings",
    stateMutability: "view",
    inputs: [{ name: "", type: "bytes32" }],
    outputs: [
      { name: "activeAddr", type: "address" },
      { name: "activeUpdatedAt", type: "uint64" },
      { name: "pendingAddr", type: "address" },
      { name: "pendingActivateAt", type: "uint64" },
    ],
  },
  {
    type: "event",
    name: "Deposit",
    inputs: [
      { indexed: true,  name: "payer",       type: "address" },
      { indexed: true,  name: "paymentRef",  type: "bytes32" },
      { indexed: true,  name: "idHash",      type: "bytes32" },
      { indexed: false, name: "token",       type: "address" },
      { indexed: false, name: "amount",      type: "uint256" },
      { indexed: false, name: "originRelay", type: "address" },
    ],
  },
  {
    type: "event",
    name: "BindingActivated",
    inputs: [
      { indexed: true, name: "idHash", type: "bytes32" },
      { indexed: true, name: "addr",   type: "address" },
    ],
  },
  {
    type: "event",
    name: "BindingPending",
    inputs: [
      { indexed: true,  name: "idHash",      type: "bytes32" },
      { indexed: true,  name: "addr",        type: "address" },
      { indexed: false, name: "activatesAt", type: "uint64" },
    ],
  },
  {
    type: "event",
    name: "BindingRevoked",
    inputs: [
      { indexed: true, name: "idHash",    type: "bytes32" },
      { indexed: true, name: "cancelled", type: "address" },
    ],
  },
  {
    type: "event",
    name: "Claimed",
    inputs: [
      { indexed: true,  name: "paymentRef", type: "bytes32" },
      { indexed: true,  name: "idHash",     type: "bytes32" },
      { indexed: true,  name: "recipient",  type: "address" },
      { indexed: false, name: "amount",     type: "uint256" },
      { indexed: false, name: "fee",        type: "uint256" },
    ],
  },
  {
    type: "function",
    name: "previewFee",
    stateMutability: "view",
    inputs: [
      { name: "grossAmount", type: "uint256" },
      { name: "originRelay", type: "address" },
    ],
    outputs: [
      { name: "fee",          type: "uint256" },
      { name: "relayCut",     type: "uint256" },
      { name: "treasuryCut", type: "uint256" },
      { name: "recipientAmt", type: "uint256" },
    ],
  },
] as const;
