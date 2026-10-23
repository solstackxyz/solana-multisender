#!/usr/bin/env node
/**
 * Solana multisender: send SOL or any SPL / Token-2022 token to a list of
 * wallets from a CSV, packed into as few transactions as fit.
 *
 *   node multisend.mjs recipients.csv                   dry run, SOL
 *   node multisend.mjs recipients.csv --mint <MINT>     dry run, a token
 *   node multisend.mjs recipients.csv --send            sign and send
 *
 * Run with --help for every option.
 *
 * Web version, with any wallet and one signature for any number of
 * recipients: https://solstack.xyz/tools/solana-multisender
 */
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import readline from "node:readline/promises";
import { parseArgs } from "node:util";
import {
  ComputeBudgetProgram,
  Connection,
  Keypair,
  PublicKey,
  SystemProgram,
  Transaction,
  clusterApiUrl,
} from "@solana/web3.js";
import {
  ACCOUNT_SIZE,
  ExtensionType,
  TOKEN_2022_PROGRAM_ID,
  TOKEN_PROGRAM_ID,
  createAssociatedTokenAccountIdempotentInstruction,
  createTransferCheckedInstruction,
  getAccountLen,
  getAccountTypeOfMintType,
  getAssociatedTokenAddressSync,
  getExtensionTypes,
  getMint,
  getTransferFeeConfig,
  getTransferHook,
} from "@solana/spl-token";

const USAGE = `Usage: node multisend.mjs <recipients.csv> [options]

The CSV has one recipient per line: <wallet address>,<amount>
Amounts are in whole tokens (1.5 means 1.5 SOL or 1.5 tokens).
A header line and lines starting with # are skipped.

Options
  --mint <address>        send this SPL or Token-2022 token instead of SOL
  --keypair <path>        sender keypair file (default ~/.config/solana/id.json)
  --cluster <name>        devnet (default), mainnet-beta or testnet
  --rpc <url>             RPC endpoint, overrides --cluster
  --priority-fee <n>      priority fee in micro-lamports per compute unit (default 0)
  --log <path>            where confirmed sends are recorded
                          (default <csv name>.<cluster>.<SOL or mint>.sent.csv)
  --send                  sign and send; without it nothing is sent
  --yes                   skip the confirmation prompt on mainnet
  -h, --help              show this help`;

const { values: opt, positionals } = parseArgs({
  allowPositionals: true,
  options: {
    mint: { type: "string" },
    keypair: { type: "string", default: path.join(os.homedir(), ".config", "solana", "id.json") },
    cluster: { type: "string", default: "devnet" },
    rpc: { type: "string" },
    "priority-fee": { type: "string", default: "0" },
    log: { type: "string" },
    send: { type: "boolean", default: false },
    yes: { type: "boolean", default: false },
    help: { type: "boolean", short: "h", default: false },
  },
});

const fail = (msg) => {
  console.error(`\nError: ${msg}`);
  process.exit(1);
};
if (opt.help || positionals.length !== 1) {
  console.log(USAGE);
  process.exit(opt.help ? 0 : 1);
}

// Transactions over 1,232 bytes are rejected by the network.
const MAX_TX_BYTES = 1232;
const BASE_FEE_LAMPORTS = 5000;
const GENESIS = {
  "5eykt4UsFv8P8NJdTREpY1vzqKqZKvdpKuc147dw2N9d": "mainnet",
  EtWTRABZaYq6iMfeYKouRu166VU2xqa1wcaWoxPkrZBG: "devnet",
  "4uhcVJyU9pJkvQyS88uRDiswHXSCkY3zQawwpjk2NsNY": "testnet",
};

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const chunk = (list, n) => Array.from({ length: Math.ceil(list.length / n) }, (_, i) => list.slice(i * n, i * n + n));

// Decimal string → integer base units, without going through floats.
const toRaw = (amount, decimals) => {
  const [whole, frac = ""] = amount.split(".");
  if (frac.length > decimals) throw new Error(`${amount} has more than ${decimals} decimals`);
  return BigInt(whole + frac.padEnd(decimals, "0"));
};
const fromRaw = (raw, decimals) => {
  const s = raw.toString().padStart(decimals + 1, "0");
  const whole = s.slice(0, s.length - decimals).replace(/\B(?=(\d{3})+(?!\d))/g, ",");
  const frac = s.slice(s.length - decimals).replace(/0+$/, "");
  return frac ? `${whole}.${frac}` : whole;
};
const sol = (lamports) => fromRaw(BigInt(lamports), 9);

const loadKeypair = (file) => {
  const full = file.replace(/^~(?=$|\/)/, os.homedir());
  if (!fs.existsSync(full)) fail(`no keypair at ${full}. Create one with \`solana-keygen new\` or pass --keypair.`);
  return Keypair.fromSecretKey(Uint8Array.from(JSON.parse(fs.readFileSync(full, "utf8"))));
};

// "<wallet>,<amount>" per line. Comma, semicolon, tab or space separated.
const readCsv = (file) => {
  if (!fs.existsSync(file)) fail(`no file at ${file}`);
  const rows = [];
  const errors = [];
  fs.readFileSync(file, "utf8").split(/\r?\n/).forEach((line, i) => {
    const text = line.trim();
    if (!text || text.startsWith("#")) return;
    const [address = "", amount = "", extra = ""] = text.split(/[,;\t ]+/);
    // "1,000" splits into "1" and "000"; refuse it rather than send 1.
    if (/^\d{3}(\.\d+)?$/.test(extra)) {
      errors.push(`line ${i + 1}: write amounts without thousands separators (1000, not 1,000)`);
      return;
    }
    let owner = null;
    try {
      owner = new PublicKey(address);
      // PublicKey pads short base58 strings; a real address round-trips.
      if (owner.toBase58() !== address) owner = null;
    } catch {}
    if (!owner) {
      if (!rows.length && !errors.length && !/^\d/.test(amount)) return; // header
      errors.push(`line ${i + 1}: "${address}" is not a Solana address`);
      return;
    }
    if (!/^\d+(\.\d+)?$/.test(amount)) {
      errors.push(`line ${i + 1}: "${amount}" is not an amount`);
      return;
    }
    rows.push({ line: i + 1, owner, amount });
  });
  if (errors.length) fail(`${file} has problems:\n  ${errors.join("\n  ")}`);
  if (!rows.length) fail(`${file} has no recipients`);
  return rows;
};

// Greedily fill each transaction with whole recipients until the next one
// would push it past the size limit.
const pack = (groups, feePayer, reserved) => {
  const size = (ixs) => {
    const tx = new Transaction({ feePayer, recentBlockhash: PublicKey.default.toBase58() }).add(...reserved, ...ixs);
    return tx.serializeMessage().length + 1 + 64;
  };
  const batches = [];
  let cur = [];
  for (const g of groups) {
    const next = [...cur, g];
    if (cur.length && size(next.flatMap((x) => x.ixs)) > MAX_TX_BYTES) {
      batches.push(cur);
      cur = [g];
    } else cur = next;
  }
  if (cur.length) batches.push(cur);
  return batches;
};

// Send, rebroadcast every 2 s until confirmed, and only re-sign with a new
// blockhash once the old one has expired, so a batch can never land twice.
const sendAndConfirm = async (conn, build) => {
  for (let attempt = 1; attempt <= 3; attempt++) {
    const { blockhash, lastValidBlockHeight } = await conn.getLatestBlockhash("confirmed");
    const raw = build(blockhash).serialize();
    const sig = await conn.sendRawTransaction(raw, { maxRetries: 0 });
    for (;;) {
      await sleep(2000);
      const { value: [st] } = await conn.getSignatureStatuses([sig]);
      if (st?.err) throw new Error(`transaction ${sig} failed: ${JSON.stringify(st.err)}`);
      if (st?.confirmationStatus === "confirmed" || st?.confirmationStatus === "finalized") return sig;
      if ((await conn.getBlockHeight("confirmed")) > lastValidBlockHeight) break;
      conn.sendRawTransaction(raw, { skipPreflight: true, maxRetries: 0 }).catch(() => {});
    }
    const { value: [st] } = await conn.getSignatureStatuses([sig], { searchTransactionHistory: true });
    if (st && !st.err) return sig;
    console.log(`    ${sig} expired before it landed, signing again with a new blockhash`);
  }
  throw new Error("not confirmed after 3 attempts; the network may be congested, try --priority-fee");
};

// ---- setup -------------------------------------------------------------------
const csvFile = positionals[0];
const rpc = opt.rpc || clusterApiUrl(opt.cluster === "mainnet" ? "mainnet-beta" : opt.cluster);
const conn = new Connection(rpc, "confirmed");
const cluster = GENESIS[await conn.getGenesisHash()] || "custom";
const payer = loadKeypair(opt.keypair);
const priorityFee = Number(opt["priority-fee"]);
if (!Number.isInteger(priorityFee) || priorityFee < 0) fail("--priority-fee must be a whole number of micro-lamports");
const rows = readCsv(csvFile);

let mint = null;
let mintInfo = null;
let programId = null;
let decimals = 9;
if (opt.mint) {
  try {
    mint = new PublicKey(opt.mint);
  } catch {
    fail(`--mint ${opt.mint} is not an address`);
  }
  const info = await conn.getAccountInfo(mint);
  if (!info) fail(`mint ${mint.toBase58()} doesn't exist on ${cluster}`);
  programId = info.owner;
  if (!programId.equals(TOKEN_PROGRAM_ID) && !programId.equals(TOKEN_2022_PROGRAM_ID)) fail(`${mint.toBase58()} is not a token mint`);
  mintInfo = await getMint(conn, mint, "confirmed", programId);
  const hook = getTransferHook(mintInfo);
  if (hook && !hook.programId.equals(PublicKey.default)) fail("this mint has a transfer hook, which this script doesn't support");
  decimals = mintInfo.decimals;
}
const isT22 = programId?.equals(TOKEN_2022_PROGRAM_ID);

// Merge duplicate wallets into one send.
const recipients = new Map();
let merged = 0;
for (const r of rows) {
  let raw;
  try {
    raw = toRaw(r.amount, decimals);
  } catch (e) {
    fail(`line ${r.line}: ${e.message}`);
  }
  if (raw === 0n) fail(`line ${r.line}: amount is 0`);
  const key = r.owner.toBase58();
  if (recipients.has(key)) {
    recipients.get(key).raw += raw;
    merged++;
  } else recipients.set(key, { owner: r.owner, raw, line: r.line });
}

// Wallets already paid by an earlier run of the same send are skipped.
const asset = mint ? mint.toBase58() : "SOL";
const logFile = opt.log || `${csvFile.replace(/\.csv$/i, "")}.${cluster}.${asset}.sent.csv`;
const done = new Set(
  fs.existsSync(logFile)
    ? fs.readFileSync(logFile, "utf8").split(/\r?\n/).slice(1).filter(Boolean).map((l) => l.split(",")[0])
    : []
);
const todo = [...recipients.values()].filter((r) => !done.has(r.owner.toBase58()));

// ---- checks ------------------------------------------------------------------
const getInfos = async (keys) => {
  const out = [];
  for (const c of chunk(keys, 100)) out.push(...(await conn.getMultipleAccountsInfo(c)));
  return out;
};
const errors = [];
const ownerInfos = await getInfos(todo.map((r) => r.owner));
const rentFloor = await conn.getMinimumBalanceForRentExemption(0);
todo.forEach((r, i) => {
  const o = ownerInfos[i]?.owner;
  if (o && (o.equals(TOKEN_PROGRAM_ID) || o.equals(TOKEN_2022_PROGRAM_ID)))
    errors.push(`line ${r.line}: ${r.owner.toBase58()} is a token account, not a wallet`);
  if (!mint && !ownerInfos[i] && r.raw < BigInt(rentFloor))
    errors.push(`line ${r.line}: a new wallet needs at least ${sol(rentFloor)} SOL, got ${fromRaw(r.raw, 9)}`);
});
const offCurve = todo.filter((r) => !PublicKey.isOnCurve(r.owner.toBytes())).length;

let source = null;
let ataRent = 0;
if (mint) {
  source = getAssociatedTokenAddressSync(mint, payer.publicKey, true, programId);
  todo.forEach((r) => (r.ata = getAssociatedTokenAddressSync(mint, r.owner, true, programId)));
  const ataInfos = await getInfos(todo.map((r) => r.ata));
  todo.forEach((r, i) => (r.needsAta = !ataInfos[i]));
  const len = isT22
    ? getAccountLen([
        ...getExtensionTypes(mintInfo.tlvData).map(getAccountTypeOfMintType).filter((t) => t !== ExtensionType.Uninitialized),
        ExtensionType.ImmutableOwner,
      ])
    : ACCOUNT_SIZE;
  ataRent = await conn.getMinimumBalanceForRentExemption(len);
}
if (errors.length) fail(`${csvFile} has problems:\n  ${errors.join("\n  ")}`);

// ---- plan --------------------------------------------------------------------
const groups = todo.map((r) => ({
  r,
  ixs: mint
    ? [
        ...(r.needsAta
          ? [createAssociatedTokenAccountIdempotentInstruction(payer.publicKey, r.ata, r.owner, mint, programId)]
          : []),
        createTransferCheckedInstruction(source, mint, r.ata, payer.publicKey, r.raw, decimals, [], programId),
      ]
    : [SystemProgram.transfer({ fromPubkey: payer.publicKey, toPubkey: r.owner, lamports: r.raw })],
}));
const budgetIxs = (units) => [
  ComputeBudgetProgram.setComputeUnitLimit({ units }),
  ComputeBudgetProgram.setComputeUnitPrice({ microLamports: priorityFee }),
];
const batches = pack(groups, payer.publicKey, priorityFee ? budgetIxs(1_400_000) : []);
const total = todo.reduce((s, r) => s + r.raw, 0n);
const newAtas = todo.filter((r) => r.needsAta).length;
const fees = batches.length * BASE_FEE_LAMPORTS;

const solBalance = await conn.getBalance(payer.publicKey);
let tokenBalance = null;
if (mint) {
  const bal = await conn.getTokenAccountBalance(source).catch(() => null);
  tokenBalance = bal ? BigInt(bal.value.amount) : 0n;
}

const unit = mint ? "" : " SOL";
console.log(`
Network      ${cluster} (${rpc})
Sender       ${payer.publicKey.toBase58()}
Sending      ${mint ? `${asset} (${isT22 ? "Token-2022" : "SPL Token"}, ${decimals} decimals)` : "SOL"}
Recipients   ${todo.length}${merged ? ` (${merged} duplicate line${merged > 1 ? "s" : ""} merged)` : ""}${recipients.size > todo.length ? `, ${recipients.size - todo.length} skipped as already sent (${logFile})` : ""}
Total        ${fromRaw(total, decimals)}${unit}${mint ? `\nNew accounts ${newAtas} token accounts to create (rent ${sol(newAtas * ataRent)} SOL, paid by the sender)` : ""}
Transactions ${batches.length} (network fees ${sol(fees)} SOL${priorityFee ? " plus priority fees" : ""})`);

const feeConfig = mintInfo && getTransferFeeConfig(mintInfo);
let feeBps = 0;
if (feeConfig) {
  const { epoch } = await conn.getEpochInfo();
  const fee = BigInt(epoch) >= feeConfig.newerTransferFee.epoch ? feeConfig.newerTransferFee : feeConfig.olderTransferFee;
  feeBps = fee.transferFeeBasisPoints;
}
if (feeBps) console.log(`\nNote: this mint charges a ${feeBps / 100}% transfer fee, so each wallet receives its amount minus that fee.`);
if (offCurve) console.log(`\nNote: ${offCurve} recipient${offCurve > 1 ? "s are" : " is a"} program address${offCurve > 1 ? "es" : ""} (a PDA, not a wallet with a key). Check that's intended.`);

if (!todo.length) {
  console.log("\nNothing left to send.");
  process.exit(0);
}
// The sender's own account has to stay above the rent minimum too.
const solNeeded = (mint ? 0n : total) + BigInt(fees + newAtas * ataRent + rentFloor);
if (BigInt(solBalance) < solNeeded) fail(`the sender has ${sol(solBalance)} SOL and needs at least ${sol(solNeeded)}`);
if (mint && tokenBalance < total)
  fail(`the sender's token account ${source.toBase58()} holds ${fromRaw(tokenBalance, decimals)}, the CSV needs ${fromRaw(total, decimals)}`);

if (!opt.send) {
  console.log(`\nDry run: nothing was sent. Add --send to sign and send ${batches.length} transaction${batches.length > 1 ? "s" : ""}.`);
  process.exit(0);
}
if (cluster === "mainnet" && !opt.yes) {
  const rl = readline.createInterface({ input: process.stdin, output: process.stdout });
  const answer = await rl.question(`\nThis spends real funds on mainnet. Type "yes" to send: `);
  rl.close();
  if (answer.trim().toLowerCase() !== "yes") fail("cancelled");
}

// ---- send --------------------------------------------------------------------
if (!fs.existsSync(logFile)) fs.writeFileSync(logFile, "address,amount,signature\n");
console.log("");
let sent = 0;
for (const [i, batch] of batches.entries()) {
  const ixs = batch.flatMap((g) => g.ixs);
  let units = null;
  try {
    if (priorityFee) {
      // Simulate once to size the compute limit, so the priority fee is
      // paid on what the batch uses rather than on 1.4M units.
      const probe = new Transaction({ feePayer: payer.publicKey }).add(...budgetIxs(1_400_000), ...ixs);
      const sim = await conn.simulateTransaction(probe);
      if (sim.value.err) throw new Error(`simulation failed: ${JSON.stringify(sim.value.err)}\n${(sim.value.logs || []).join("\n")}`);
      units = Math.ceil(sim.value.unitsConsumed * 1.1) + 1000;
    }
    const sig = await sendAndConfirm(conn, (blockhash) => {
      const tx = new Transaction({ feePayer: payer.publicKey, recentBlockhash: blockhash });
      if (units) tx.add(...budgetIxs(units));
      tx.add(...ixs).sign(payer);
      return tx;
    });
    fs.appendFileSync(logFile, batch.map((g) => `${g.r.owner.toBase58()},${fromRaw(g.r.raw, decimals).replace(/,/g, "")},${sig}\n`).join(""));
    sent += batch.length;
    console.log(`[${i + 1}/${batches.length}] ${batch.length} recipient${batch.length > 1 ? "s" : ""}  ${sig}`);
  } catch (e) {
    console.error(`\n[${i + 1}/${batches.length}] ${e.message}`);
    fail(`${sent} of ${todo.length} recipients were paid. Run the same command again to continue; wallets in ${logFile} are skipped.`);
  }
}
console.log(`\nDone: ${sent} recipients paid. Signatures are in ${logFile}.`);
