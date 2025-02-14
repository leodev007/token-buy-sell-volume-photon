import { CommitmentLevel, SubscribeRequest } from "@triton-one/yellowstone-grpc";
import { logger } from "../utils/logger";
import { CHECK_UPDATEAUTHORITY_BLACKLIST, LEADER_CHECK, MAX_SECONDS_FROM_POOL_OPEN_TO_TOKEN_STREAMED, PRIVATE_KEY, RPC_ENDPOINT, RPC_WEBSOCKET_ENDPOINT, SECONDS_TO_WAIT_AFTER_BUY_BEFORE_CONTINUING_SNIPING } from "../constants";

import Client from "@triton-one/yellowstone-grpc";
import { BigNumberish, LIQUIDITY_STATE_LAYOUT_V4, MARKET_STATE_LAYOUT_V3, TOKEN_PROGRAM_ID, array } from "@raydium-io/raydium-sdk";
import { Connection, KeyedAccountInfo, Keypair, PublicKey } from "@solana/web3.js";
import { blacklistCache, mapRingFilter } from "./openbook-filtered";
import { buy, sell } from "../transaction/transaction";
import { leaderSchedule } from "../transaction/transaction";
import { TokensProcessedCache } from '../cache/tokens-processed.cache';
import { runTimestamp } from '../test';
import { bufferFilterCheckedAlready, tokenUpdateAuthorityMap } from "./openbook-filtered";
import * as readline from 'readline'; // Import readline module
import { appendToFile } from "../utils/file";
import { sleep } from "../utils/sleep";
import { openURL } from "../utils/x11";
import bs58 from 'bs58'
import { AccountLayout, getAssociatedTokenAddress, NATIVE_MINT } from "@solana/spl-token";
import { priceMatch } from "../utils";

const client = new Client("http://grpc.solanavibestation.com:10000", undefined, undefined);

const solanaConnection = new Connection(RPC_ENDPOINT, {
  wsEndpoint: RPC_WEBSOCKET_ENDPOINT,
})
const wallet = Keypair.fromSecretKey(bs58.decode(PRIVATE_KEY))

const tokensProcessedCache = new TokensProcessedCache();

let currentTokenMint: string;
let quoteTokenAssociatedAddress: PublicKey
let timesChecked: number = 0

let poolState: any
let marketDetails: any | undefined;

readline.emitKeypressEvents(process.stdin);
if (process.stdin.isTTY) {
  process.stdin.setRawMode(true);
}

const rl = readline.createInterface({
  input: process.stdin,
  output: process.stdout
})

if (CHECK_UPDATEAUTHORITY_BLACKLIST) {

  process.stdin.on('keypress', (str, key) => {
    if (key && key.name) {
      const inputKey = `${str}`; // Generate key based on input      

      if (inputKey == 'b') {

        const tokenUpdateAuthority = tokenUpdateAuthorityMap.get(currentTokenMint);
        if (tokenUpdateAuthority) {

          if (blacklistCache?.isInListBS(tokenUpdateAuthority)) {
            logger.info(`Mint: ${currentTokenMint} | ${tokenUpdateAuthority} already in blacklist`);
          } else {
            appendToFile('./blacklist.txt', tokenUpdateAuthority);
            blacklistCache.init(true);
            logger.info(`Mint: ${currentTokenMint} | Added ${tokenUpdateAuthority} to blacklist`);
          }

        } else {
          logger.info(`Info for current token not found to add to blacklist`);
        }

      }

      if (inputKey == 'z') {
        process.exit();
      }
    }
  });

}

(async () => {
  const version = await client.getVersion(); // gets the version information
  console.log(version);
})();

let latestBlockHash: string = "";
let slotCheckResult: boolean = false;
export let newTokenTimestamp: number;
export let newTokenTimestampPerf: number;

let processingToken: Boolean = false

export async function streamNewTokens() {

  quoteTokenAssociatedAddress = await getAssociatedTokenAddress(NATIVE_MINT, wallet.publicKey)

  const stream = await client.subscribe();
  // Collecting all incoming events.
  stream.on("data", async (data) => {

    if (!processingToken) {

      if (data.blockMeta) {
        latestBlockHash = data.blockMeta.blockhash;
      }

      if (data.account != undefined) {
        newTokenTimestamp = Math.floor(Date.now() / 1000);
        newTokenTimestampPerf = performance.now();
        poolState = LIQUIDITY_STATE_LAYOUT_V4.decode(data.account.account.data);
        const baseMintString = poolState.baseMint.toString()
        currentTokenMint = baseMintString;
        const tokenAccount = new PublicKey(data.account.account.pubkey);
        let poolOpenTime = parseInt(poolState.poolOpenTime.toString());
        let elapsedOpentoStream = newTokenTimestamp - poolOpenTime;

        if (baseMintString.endsWith('pump')) {
          poolOpenTime = newTokenTimestamp + 1;
          elapsedOpentoStream = 1;
        }

        const exists = tokensProcessedCache.isInList(baseMintString, true);
        const freshLaunch = (!exists && poolOpenTime > runTimestamp) ? true : false;

        if (freshLaunch && elapsedOpentoStream < MAX_SECONDS_FROM_POOL_OPEN_TO_TOKEN_STREAMED && elapsedOpentoStream > -10) {

          if (LEADER_CHECK) {
            let slotToCheck = Number(data.account.slot);
            let slotFound: number = 0;
            for (let i = 1; i < 3; i++) {
              const exists = leaderSchedule.has(slotToCheck + i);
              slotFound = slotToCheck + i;

              if (exists === true) {
                slotCheckResult = true;
                break;
              }
            }

            if (slotCheckResult) {
              logger.info(`Slot: ${data.account.slot} | Slot found: ${slotFound}`);
            }
          }

          if (!slotCheckResult && LEADER_CHECK) {

            logger.error(`No up coming Jito leaders. Slot: ${data.account.slot}`)
          } else {

            let attempts = 0;
            const maxAttempts = 100;
            const retryEvery = 10;
            const intervalId = setInterval(async () => {

              marketDetails = mapRingFilter.search(baseMintString)

              if (marketDetails != undefined) {
                processingToken = true

                console.log("🚀 ~ processingToken - 1:", processingToken)

                buy(latestBlockHash, tokenAccount, poolState, marketDetails);

                await priceMatch(tokenAccount, poolState, marketDetails, wallet.publicKey)

                sell(latestBlockHash, tokenAccount, poolState, marketDetails)

                outputTokenLogs(
                  tokenAccount.toString(),
                  baseMintString,
                  elapsedOpentoStream,
                  // buyTimestampPerf,
                  // bufferSearchTimestampPerf,
                  // elapsedStreamToBuyPerf
                );

                clearInterval(intervalId); // Stop retrying when a match is found

              } else if (attempts >= maxAttempts) {

                outputTokenLogs(
                  tokenAccount.toString(),
                  baseMintString,
                  elapsedOpentoStream
                );

                const failedFilter = bufferFilterCheckedAlready.findPattern(poolState.baseMint);
                if (Buffer.isBuffer(failedFilter)) {
                  logger.error("Not matching filters");
                } else {
                  logger.error("Invalid market details");
                }

                clearInterval(intervalId); // Stop retrying after maxAttempts

              }


              attempts++;
            }, retryEvery); // Retry every 10ms

          }

          tokensProcessedCache.saveSorted(baseMintString);
          slotCheckResult = false;

        } else {

          if (elapsedOpentoStream > MAX_SECONDS_FROM_POOL_OPEN_TO_TOKEN_STREAMED && elapsedOpentoStream < 200 && !exists) {
            outputTokenLogs(tokenAccount.toString(), baseMintString, elapsedOpentoStream)







            logger.error(`Streamed too long ago. Max time: ${MAX_SECONDS_FROM_POOL_OPEN_TO_TOKEN_STREAMED} seconds`);
          }

        }
      }
    }
  });

  const walletSubscriptionId = solanaConnection.onProgramAccountChange(
    TOKEN_PROGRAM_ID,
    async (updatedAccountInfo) => {
      await walletChange(updatedAccountInfo)
    },
    "confirmed",
    [
      {
        dataSize: 165,
      },
      {
        memcmp: {
          offset: 32,
          bytes: wallet.publicKey.toBase58(),
        }
      }
    ],
  )

  // Create a subscription request.
  const request: SubscribeRequest = {
    "slots": {},
    "accounts": {
      "raydium": {
        "account": [],
        "filters": [
          {
            "memcmp": {
              "offset": LIQUIDITY_STATE_LAYOUT_V4.offsetOf('quoteMint').toString(), // Filter for only tokens paired with SOL
              "base58": "So11111111111111111111111111111111111111112"
            }
          }
          , {
            "memcmp": {
              "offset": LIQUIDITY_STATE_LAYOUT_V4.offsetOf('marketProgramId').toString(), // Filter for only Raydium markets that contain references to Serum
              "base58": "srmqPvymJeFKQ4zGQed1GFppgkRHL9kaELCbyksJtPX"
            }
          }

          , {
            "memcmp": {
              "offset": LIQUIDITY_STATE_LAYOUT_V4.offsetOf('swapQuoteInAmount').toString(), // Hack to filter for only new tokens. There is probably a better way to do this
              "bytes": Uint8Array.from([0])
            }
          }
          , {
            "memcmp": {
              "offset": LIQUIDITY_STATE_LAYOUT_V4.offsetOf('swapBaseOutAmount').toString(), // Hack to filter for only new tokens. There is probably a better way to do this
              "bytes": Uint8Array.from([0])
            }
          }

          // ,{
          //   "memcmp": {
          //     "offset": LIQUIDITY_STATE_LAYOUT_V4.offsetOf('status').toString(),
          //     "bytes": new Uint8Array([6, 0, 0, 0, 0, 0, 0, 0])
          //   }
          // }

        ],
        "owner": ["675kPX9MHTjS2zt1qfr1NYHuzeLXfQM9H24wFSUt1Mp8"] // raydium program id to subscribe to
      }
    },
    "transactions": {},
    "blocks": {},
    "blocksMeta": {
      "block": []
    },
    "accountsDataSlice": [],
    "commitment": CommitmentLevel.PROCESSED,  // Subscribe to processed blocks for the fastest updates
    entry: {}
  }

  // Sending a subscription request.
  await new Promise<void>((resolve, reject) => {
    stream.write(request, (err: null | undefined) => {
      if (err === null || err === undefined) {
        resolve();
      } else {
        reject(err);
      }
    });
  }).catch((reason) => {
    console.error(reason);
    throw reason;
  });
}



function outputTokenLogs(tokenAccount: string, baseMint: string, elapsedOpentoStream: number, foundBufferTimestampPerf?: number, bufferSearchTimestampPerf?: number, elapsedStreamToBuyPerf?: number) {
  logger.info(`•☽────────────────────────────✧˖°˖☆˖°˖✧────────────────────────────☾•\n`);
  logger.info(`Token Account: ${tokenAccount}`);
  logger.info(`Base Mint: ${baseMint}`);
  logger.info(`https://photon-sol.tinyastro.io/en/lp/${tokenAccount}`);
  logger.info(`https://gmgn.ai/sol/token/${baseMint}`);
  logger.info(``);
  logger.warn(`Time elapsed (Pool open > Streamed): ${elapsedOpentoStream} seconds`);
  if (foundBufferTimestampPerf && bufferSearchTimestampPerf) {
    logger.warn(`Time elapsed (Search for market info): ${foundBufferTimestampPerf - bufferSearchTimestampPerf}ms`);
  }
  if (elapsedStreamToBuyPerf) {
    logger.warn(`Time elapsed (Streamed > Buy): ${elapsedStreamToBuyPerf}ms`);
  }

}

function openAnalytics(tokenAccount: string, baseMint: string) {
  openURL(`https://photon-sol.tinyastro.io/en/lp/${tokenAccount}`)
  openURL(`https://gmgn.ai/sol/token/${baseMint}`)
}

let bought: string = NATIVE_MINT.toBase58()

const walletChange = async (updatedAccountInfo: KeyedAccountInfo) => {
  const accountData = AccountLayout.decode(updatedAccountInfo.accountInfo!.data)
  if (updatedAccountInfo.accountId.equals(quoteTokenAssociatedAddress)) {
    return
  }
  // if (tokenAccountInCommon && accountDataInCommon) {

  // if (bought != accountDataInCommon.baseMint.toBase58()) {
  console.log(`\n--------------- bought token successfully ---------------------- \n`)
  // console.log(`https://dexscreener.com/solana/${accountDataInCommon.baseMint.toBase58()}`)
  // console.log(`PHOTON: https://photon-sol.tinyastro.io/en/lp/${tokenAccountInCommon.poolKeys!.id.toString()}`)
  // console.log(`DEXSCREENER: https://dexscreener.com/solana/${tokenAccountInCommon.poolKeys!.id.toString()}`)
  // console.log(`JUPITER: https://jup.ag/swap/${accountDataInCommon.baseMint.toBase58()}-SOL`)
  // console.log(`BIRDEYE: https://birdeye.so/token/${accountDataInCommon.baseMint.toBase58()}?chain=solana\n\n`)
  // bought = accountDataInCommon.baseMint.toBase58()

  const tokenAccount = await getAssociatedTokenAddress(accountData.mint, wallet.publicKey)
  const tokenBalance = await getTokenBalance(tokenAccount)
  if (tokenBalance == "0") {
    console.log(`Detected a new pool, but didn't confirm buy action`)
    return
  }

  // const tokenIn = new Token(TOKEN_PROGRAM_ID, tokenAccountInCommon.poolKeys!.baseMint, tokenAccountInCommon.poolKeys!.baseDecimals)
  // const tokenAmountIn = new TokenAmount(tokenIn, tokenBalance, true)
  // inputAction(updatedAccountInfo.accountId, accountData.mint, tokenBalance)
  // await priceMatch(tokenAmountIn, tokenAccountInCommon.poolKeys!)
  
  const tokenBalanceAfterCheck = await getTokenBalance(tokenAccount)
  if (tokenBalanceAfterCheck == "0") {
    processingToken = false
    console.log("🚀 ~ processingToken - 2:", processingToken)
    return
  }
  
  console.log("============================= Selling now =====================================")
  
  // sell(latestBlockHash, tokenAccount, poolState, marketDetails);
  
  console.log("========================== Successfully Sold ==================================")

  await getTokenBalance(tokenAccount)

  inputAction(updatedAccountInfo.accountId, accountData.mint, tokenBalance)

  // if (soldSome) {
  // soldSome = false
  // const _ = await sell(tokenAccountInCommon.poolKeys!.baseMint, tokenBalanceAfterCheck)
  // } else {
  // const _ = await sell(tokenAccountInCommon.poolKeys!.baseMint, accountData.amount)
  // }
  // }
  // }
}

const getTokenBalance = async (tokenAccount: PublicKey) => {
  let tokenBalance = "0"
  let index = 0
  do {
    try {
      const tokenBal = (await solanaConnection.getTokenAccountBalance(tokenAccount, 'processed')).value
      const uiAmount = tokenBal.uiAmount
      if (index > 10) {
        break
      }
      if (uiAmount && uiAmount > 0) {
        tokenBalance = tokenBal.amount
        console.log(`Token balance is ${uiAmount}`)
        break
      }
      await sleep(1000)
      index++
    } catch (error) {
      await sleep(500)
    }
  } while (true);
  return tokenBalance
}

const inputAction = async (accountId: PublicKey, mint: PublicKey, amount: BigNumberish) => {
  // console.log("\n\n\n==========================================================\n\n\n")
  rl.question('If you want to snipe next token, plz input "next" and press enter: \n\n', async (data) => {
    const input = data.toString().trim()
    if (input === 'next') {
      timesChecked = 1000000
      processingToken = false
      console.log("🚀 ~ processingToken - 3:", processingToken)

    } else {
      console.log('Received input invalid :\t', input)
      inputAction(accountId, mint, amount)
    }
  })
}