# Solana Multisender (CLI)

Send SOL or any SPL / Token-2022 token to hundreds of wallets from a CSV file, packed into as few transactions as fit. One small Node.js script, no build step.

> Prefer a web app? **[Solstack Multisender](https://solstack.xyz/tools/solana-multisender)** does the same from any wallet (Phantom, Solflare, Ledger), with one signature for any number of recipients. Guide: [How to use the Solana multisender](https://solstack.xyz/docs/solana-multisender).

## What it does

- Sends **SOL**, **SPL Token** or **Token-2022** tokens (including tokens with a transfer fee).
- Creates each recipient's token account when they don't have one yet, and tells you the rent before you send.
- Fits as many recipients into each transaction as the 1,232-byte limit allows: 21 per transaction for SOL, 20 for a token to wallets that already hold it, 10 for a token to new wallets (one fewer each with a priority fee).
- **Dry run by default.** Nothing is signed until you add `--send`.
- **Never pays a wallet twice.** Every confirmed send is written to a log file, and a rerun skips those wallets. A transaction is only signed again once its blockhash has expired, so it can't land twice.
- Checks the CSV before it spends anything: bad addresses, `1,000`-style amounts, token accounts pasted instead of wallets, too many decimals, SOL amounts below the rent minimum for a new wallet, and whether you hold enough.

## Quick start

Needs [Node.js](https://nodejs.org) 18.11 or newer and a keypair file (the [Solana CLI](https://solana.com/docs/intro/installation) one at `~/.config/solana/id.json` is used by default).

```sh
git clone https://github.com/solstackxyz/solana-multisender.git
cd solana-multisender
npm install

# dry run on devnet: shows the plan, sends nothing
node multisend.mjs recipients.csv

# send a token on devnet
node multisend.mjs recipients.csv --mint <MINT ADDRESS> --send

# send on mainnet with a priority fee
node multisend.mjs recipients.csv --mint <MINT ADDRESS> --cluster mainnet-beta --priority-fee 20000 --send
```

Test on devnet first. Free devnet SOL: [Solana Devnet Faucet](https://solstack.xyz/tools/solana-devnet-faucet).

## CSV format

One recipient per line, wallet address then amount in whole tokens. A header line and lines starting with `#` are skipped. Commas, semicolons, tabs or spaces all work as separators.

```csv
address,amount
G6CsNBwRMdDdgY9YFSsrMm2Ft7W6qNbWyfUFCTbVSuQx,1000.25
5Nc55uzVwjwuDbhNLXiJJXqPddXtLJESpr5JDUjMSNXu,2000
DdnAF1B9FLxYHXxTgYXe6UH9Xhzky2vEPhnZVrLEBfXX,0.5
```

A wallet listed twice gets one send with the amounts added together. See [`recipients.example.csv`](recipients.example.csv).

## Options

| Option | What it does |
|---|---|
| `--mint <address>` | Send this SPL or Token-2022 token instead of SOL |
| `--keypair <path>` | Sender keypair file (default `~/.config/solana/id.json`) |
| `--cluster <name>` | `devnet` (default), `mainnet-beta` or `testnet` |
| `--rpc <url>` | Your own RPC endpoint; overrides `--cluster` |
| `--priority-fee <n>` | Priority fee in micro-lamports per compute unit (default 0). The compute limit is sized from a simulation, so you pay the fee on what each batch uses |
| `--log <path>` | Where confirmed sends are recorded (default `<csv>.<cluster>.<SOL or mint>.sent.csv`) |
| `--send` | Sign and send. Without it, nothing is sent |
| `--yes` | Skip the "type yes" prompt on mainnet |

## Example

A real devnet run: an SPL token to 12 wallets that didn't have a token account yet.

```text
$ node multisend.mjs m1.csv --mint 8iCvwEvSaMGLgw82EBeny5522dx1TfLZi3SUkXFXuQXG --priority-fee 1000 --send

Network      devnet (https://api.devnet.solana.com)
Sender       79o36ZBByMEF12iX7c1EQ1C2Jw7bQbDzVNLoW2fEzgvs
Sending      8iCvwEvSaMGLgw82EBeny5522dx1TfLZi3SUkXFXuQXG (SPL Token, 6 decimals)
Recipients   12
Total        78,003
New accounts 12 token accounts to create (rent 0.01786128 SOL, paid by the sender)
Transactions 2 (network fees 0.00001 SOL plus priority fees)

[1/2] 9 recipients  3YgJmfDUS2XeXt3CjGjXCgRr8EKRc64t9DNhVdmAPp7NVYaNdzAKSiaa6YUK12CFhQat1GH37yhX27hLQAbPYfVb
[2/2] 3 recipients  4FMFaj8Xuo4v5yk4w2Ed8q7DQafa5MiqJvbtL9ti6bGYqrF3Cq4Tem7DE1he6dzmv9rvY7adJeFQMVWtuoK5E66r

Done: 12 recipients paid. Signatures are in m1.devnet.8iCvwEvSaMGLgw82EBeny5522dx1TfLZi3SUkXFXuQXG.sent.csv.
```

If a run stops halfway (network trouble, not enough SOL), run the same command again: wallets already in the log are skipped.

## Costs

- **Network fee:** 0.000005 SOL per transaction, plus any priority fee you set.
- **Rent for new token accounts:** each recipient without a token account for your mint needs one, and the sender pays its rent. That's about 0.0015 SOL for an SPL Token account; Token-2022 accounts with extensions cost a little more. The script prints the exact total before sending.
- **This script itself is free.**

## Limits

- Tokens with a **transfer hook** need extra accounts per transfer and aren't supported.
- The sender's tokens must be in its associated token account (where wallets keep them by default).
- Each batch is its own transaction, so a large list means one signature per batch from the keypair file. For one signature from a browser wallet, use the [web multisender](https://solstack.xyz/tools/solana-multisender).

## More Solana tools

This script comes from [Solstack](https://solstack.xyz), a set of web tools for Solana tokens: [create a token](https://solstack.xyz/tools/create-solana-spl-token), [airdrop to every holder of another token](https://solstack.xyz/tools/solana-token-airdrop), [check a token's safety score](https://solstack.xyz/tools/solana-token-inspector) and [more](https://solstack.xyz/tools).

Other scripts: [solana-rent-reclaim](https://github.com/solstackxyz/solana-rent-reclaim) · [solana-holder-snapshot](https://github.com/solstackxyz/solana-holder-snapshot)

## License

MIT
