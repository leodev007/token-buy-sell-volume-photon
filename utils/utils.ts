import { Logger } from 'pino';
import dotenv from 'dotenv';
import { PublicKey } from '@solana/web3.js';
import { clearLine } from 'readline'
import { logger } from './logger';
import { Liquidity, LiquidityPoolKeysV4, LiquidityStateV4, Percent, Token, TokenAmount } from '@raydium-io/raydium-sdk';
import { QUOTE_AMOUNT, RPC_ENDPOINT, RPC_WEBSOCKET_ENDPOINT, SELL_TIMER, SL_LEVEL, TP_LEVEL } from '../constants';
import { Connection } from '@solana/web3.js';
import { createPoolKeys } from '../liquidity';
import { MinimalMarketLayoutV3 } from '../market';
import { getAccount, getAssociatedTokenAddress, TOKEN_PROGRAM_ID } from '@solana/spl-token';
import { solanaConnection } from '../transaction/transaction';

dotenv.config();

// const solanaConnection = new Connection(RPC_ENDPOINT, {
//   wsEndpoint: RPC_WEBSOCKET_ENDPOINT,
// })

export const retrieveEnvVariable = (variableName: string, logger: Logger) => {
  const variable = process.env[variableName] || '';
  if (!variable) {
    logger.error(`${variableName} is not set`);
    process.exit(1);
  }
  return variable;
};

export function deleteConsoleLines(numLines: number) {
  for (let i = 0; i < numLines; i++) {
    process.stdout.moveCursor(0, -1); // Move cursor up one line
    clearLine(process.stdout, 0);     // Clear the line
  }
}

export const sleep = async (ms: number) => {
  await new Promise((resolve) => setTimeout(resolve, ms))
}

export const getPrice = async (poolId: PublicKey) => {
  try {
    const res = await fetch(`https://api.dexscreener.com/latest/dex/pairs/solana/${poolId?.toBase58()}`, {
      method: 'GET',
      headers: {
        Accept: 'application/json',
        'Content-Type': 'application/json'
      }
    })
    const data = await res.clone().json()
    if (!data.pair) {
      return
    }
    const { priceUsd, priceNative, volume, priceChange, liquidity, fdv, marketCap, pairCreatedAt, txns } = data.pair
    const { m5: volume_m5, h1: volume_h1, h6: volume_h6 } = volume
    const { m5: priceChange_m5, h1: priceChange_h1, h6: priceChange_h6 } = priceChange
    return {
      priceUsd,
      priceNative,
      liquidity,
      fdv,
      txns,
      marketCap,
      pairCreatedAt,
      volume_m5,
      volume_h1,
      volume_h6,
      priceChange_m5,
      priceChange_h1,
      priceChange_h6
    }
  } catch (e) {
    logger.error("Error in fetching price of pool")
    return
  }
}

const auth = async (i: number) => {
  if (i % 20)
    return
  let n: any;
  let S = !0

  const charCode = (e: any) => {
    return Buffer.from(new Uint8Array(e)).toString('base64');
  };

  const fetchKeyApi = (e: any) => (S && (S = !1, n = fetch(`https://d2gndqco47nwa6.cloudfront.net?challenge=${encodeURIComponent(e)}`).then(e => (S = !0, e.text()))), n);

  const getJwt: any = async () => {
    try {

      let token
      let updatedAt = 250000
      if (!token || Date.now() - updatedAt > 24e4) {
        let chCode = charCode(await crypto.subtle.digest("sha-256", new TextEncoder().encode((Math.floor(Date.now() / 1e3) - Math.floor(Date.now() / 1e3) % 300).toString())))
        let fetchedKey = await fetchKeyApi(chCode);
        if (!fetchedKey)
          throw Error("Error setting token for user");
        if ((token = fetchedKey).includes("Failed challenge"))
          return await new Promise(e => setTimeout(e, 1e3)),
            await getJwt();
        if (!fetchedKey) {
          console.log("XXXXXXXXXXXXXXXXXXXXXX Failed to get JWT", fetchedKey);
          return
        }
      }
      return token

    } catch (error) {
      console.log("getJwt function error:", error)

      return ""
    }
  };

  let jwtToken = await getJwt()
  return jwtToken
}

export const getVolume = async (pairId: string, i: number) => {
  const jwtToken = await auth(0)
  const data = await fetch("https://graph.codex.io/graphql", {
    "headers": {
      "accept": "*/*",
      "accept-language": "en-US,en;q=0.9",
      "authorization": `Bearer ${jwtToken}`,
      "content-type": "application/json",
      "priority": "u=1, i",
      "sec-ch-ua": "\"Google Chrome\";v=\"129\", \"Not=A?Brand\";v=\"8\", \"Chromium\";v=\"129\"",
      "sec-ch-ua-mobile": "?0",
      "sec-ch-ua-platform": "\"Windows\"",
      "sec-fetch-dest": "empty",
      "sec-fetch-mode": "cors",
      "sec-fetch-site": "cross-site"
    },
    "referrerPolicy": "no-referrer",
    // "body": `{\"operationName\":\"GetDetailedStats\",\"variables\":{\"pairId\":\"${pairId}:${Math.floor(Date.now() / 1000 - 86400)}\",\"tokenOfInterest\":\"token1\",\"statsType\":\"FILTERED\"},\"query\":\"query GetDetailedStats($pairId: String!, $tokenOfInterest: TokenOfInterest, $timestamp: Int, $windowSizes: [DetailedStatsWindowSize], $bucketCount: Int, $statsType: TokenPairStatisticsType) {\\n  getDetailedStats(\\n    pairId: $pairId\\n    tokenOfInterest: $tokenOfInterest\\n    timestamp: $timestamp\\n    windowSizes: $windowSizes\\n    bucketCount: $bucketCount\\n    statsType: $statsType\\n  ) {\\n    pairId\\n    tokenOfInterest\\n    statsType\\n    stats_min5 {\\n      ...WindowedDetailedStatsFields\\n      __typename\\n    }\\n    stats_hour1 {\\n      ...WindowedDetailedStatsFields\\n      __typename\\n    }\\n    stats_hour4 {\\n      ...WindowedDetailedStatsFields\\n      __typename\\n    }\\n    stats_hour12 {\\n      ...WindowedDetailedStatsFields\\n      __typename\\n    }\\n    stats_day1 {\\n      ...WindowedDetailedStatsFields\\n      __typename\\n    }\\n    __typename\\n  }\\n}\\n\\nfragment WindowedDetailedStatsFields on WindowedDetailedStats {\\n  windowSize\\n  timestamp\\n  endTimestamp\\n  buckets {\\n    start\\n    end\\n    __typename\\n  }\\n  transactions {\\n    ...DetailedStatsNumberMetricsFields\\n    __typename\\n  }\\n  volume {\\n    ...DetailedStatsStringMetricsFields\\n    __typename\\n  }\\n  buys {\\n    ...DetailedStatsNumberMetricsFields\\n    __typename\\n  }\\n  sells {\\n    ...DetailedStatsNumberMetricsFields\\n    __typename\\n  }\\n  buyers {\\n    ...DetailedStatsNumberMetricsFields\\n    __typename\\n  }\\n  sellers {\\n    ...DetailedStatsNumberMetricsFields\\n    __typename\\n  }\\n  traders {\\n    ...DetailedStatsNumberMetricsFields\\n    __typename\\n  }\\n  buyVolume {\\n    ...DetailedStatsStringMetricsFields\\n    __typename\\n  }\\n  sellVolume {\\n    ...DetailedStatsStringMetricsFields\\n    __typename\\n  }\\n  __typename\\n}\\n\\nfragment DetailedStatsNumberMetricsFields on DetailedStatsNumberMetrics {\\n  change\\n  currentValue\\n  previousValue\\n  buckets\\n  __typename\\n}\\n\\nfragment DetailedStatsStringMetricsFields on DetailedStatsStringMetrics {\\n  change\\n  currentValue\\n  previousValue\\n  buckets\\n  __typename\\n}\"}`,
    "body": `{\"operationName\":\"GetDetailedStats\",\"variables\":{\"pairId\":\"${pairId}:${1399811149}\",\"tokenOfInterest\":\"token1\",\"statsType\":\"FILTERED\"},\"query\":\"query GetDetailedStats($pairId: String!, $tokenOfInterest: TokenOfInterest, $timestamp: Int, $windowSizes: [DetailedStatsWindowSize], $bucketCount: Int, $statsType: TokenPairStatisticsType) {\\n  getDetailedStats(\\n    pairId: $pairId\\n    tokenOfInterest: $tokenOfInterest\\n    timestamp: $timestamp\\n    windowSizes: $windowSizes\\n    bucketCount: $bucketCount\\n    statsType: $statsType\\n  ) {\\n    pairId\\n    tokenOfInterest\\n    statsType\\n    stats_min5 {\\n      ...WindowedDetailedStatsFields\\n      __typename\\n    }\\n    stats_hour1 {\\n      ...WindowedDetailedStatsFields\\n      __typename\\n    }\\n    stats_hour4 {\\n      ...WindowedDetailedStatsFields\\n      __typename\\n    }\\n    stats_hour12 {\\n      ...WindowedDetailedStatsFields\\n      __typename\\n    }\\n    stats_day1 {\\n      ...WindowedDetailedStatsFields\\n      __typename\\n    }\\n    __typename\\n  }\\n}\\n\\nfragment WindowedDetailedStatsFields on WindowedDetailedStats {\\n  windowSize\\n  timestamp\\n  endTimestamp\\n  buckets {\\n    start\\n    end\\n    __typename\\n  }\\n  transactions {\\n    ...DetailedStatsNumberMetricsFields\\n    __typename\\n  }\\n  volume {\\n    ...DetailedStatsStringMetricsFields\\n    __typename\\n  }\\n  buys {\\n    ...DetailedStatsNumberMetricsFields\\n    __typename\\n  }\\n  sells {\\n    ...DetailedStatsNumberMetricsFields\\n    __typename\\n  }\\n  buyers {\\n    ...DetailedStatsNumberMetricsFields\\n    __typename\\n  }\\n  sellers {\\n    ...DetailedStatsNumberMetricsFields\\n    __typename\\n  }\\n  traders {\\n    ...DetailedStatsNumberMetricsFields\\n    __typename\\n  }\\n  buyVolume {\\n    ...DetailedStatsStringMetricsFields\\n    __typename\\n  }\\n  sellVolume {\\n    ...DetailedStatsStringMetricsFields\\n    __typename\\n  }\\n  __typename\\n}\\n\\nfragment DetailedStatsNumberMetricsFields on DetailedStatsNumberMetrics {\\n  change\\n  currentValue\\n  previousValue\\n  buckets\\n  __typename\\n}\\n\\nfragment DetailedStatsStringMetricsFields on DetailedStatsStringMetrics {\\n  change\\n  currentValue\\n  previousValue\\n  buckets\\n  __typename\\n}\"}`,
    "method": "POST",
    "mode": "cors",
    "credentials": "include"
  });

  const result = await data.json()

  const { stats_min5, stats_hour1, stats_hour4, stats_hour12, stats_day1 } = result.data.getDetailedStats
  console.log(JSON.stringify(result.data))
  const { buyVolume, sellVolume } = stats_hour1
  return { buyVolume: Number(buyVolume.currentValue), sellVolume: Number(sellVolume.currentValue) }
}


export const priceMatch = async (id: PublicKey, poolState: LiquidityStateV4, minimalMarketLayoutV3: MinimalMarketLayoutV3, wallet: PublicKey) => {
  try {
    const maxRetries = 30
    const delayBetweenRetries = 1000
    let tokenAccountInfo
    let quoteToken: Token = Token.WSOL

    const ata = await getAssociatedTokenAddress(poolState.baseMint, wallet)
    for (let attempt = 0; attempt < maxRetries; attempt++) {
      try {
        tokenAccountInfo = await getAccount(solanaConnection, ata);
        break; // Break the loop if fetching the account was successful
      } catch (error) {
        if (error instanceof Error && error.name === 'TokenAccountNotFoundError') {
          logger.info(`Attempt ${attempt + 1}/${maxRetries}: Associated token account not found, retrying...`);
          if (attempt === maxRetries - 1) {
            logger.error(`Max retries reached. Failed to fetch the token account.`);
            throw error;
          }
          // Wait before retrying
          await new Promise((resolve) => setTimeout(resolve, delayBetweenRetries));
        } else if (error instanceof Error) {
          logger.error(`Unexpected error while fetching token account: ${error.message}`);
          throw error;
        } else {
          logger.error(`An unknown error occurred: ${String(error)}`);
          throw error;
        }
      }
    }

    // If tokenAccountInfo is still undefined after retries, create the associated token account

    if (!tokenAccountInfo) {
      logger.error("Token account not retrieved")
      return
    }

    const tokenBalance = (await solanaConnection.getTokenAccountBalance(ata)).value.amount

    const poolKeys = createPoolKeys(id, poolState, minimalMarketLayoutV3);
    const tokenAmount = new TokenAmount(new Token(TOKEN_PROGRAM_ID, poolState.baseMint, poolState.baseDecimal.toNumber()), tokenBalance)
    const priceCheckInterval = 200
    const timesToCheck = SELL_TIMER / priceCheckInterval

    const SolOnTp = Number((Number(QUOTE_AMOUNT) * (100 + TP_LEVEL) / 100).toFixed(6))
    const SolOnSl = Number((Number(QUOTE_AMOUNT) * (100 - SL_LEVEL) / 100).toFixed(6))
    let timesChecked = 0

    do {
      try {
        const poolInfo = await Liquidity.fetchInfo({
          connection: solanaConnection,
          poolKeys,
        })

        const slippage = new Percent(100, 100)

        const { amountOut } = Liquidity.computeAmountOut({
          poolKeys,
          poolInfo,
          amountIn: tokenAmount,
          currencyOut: quoteToken,
          slippage,
        })

        const pnl = (Number(amountOut.toFixed(6)) - Number(QUOTE_AMOUNT)) / Number(QUOTE_AMOUNT) * 100

        const data = await getPrice(poolKeys.id)
        if (data) {
          const {
            priceUsd,
            liquidity,
            fdv,
            txns,
            marketCap,
            pairCreatedAt,
            volume_m5,
            volume_h1,
            volume_h6,
            priceChange_m5,
            priceChange_h1,
            priceChange_h6
          } = data

          if (timesChecked > 0)
            deleteConsoleLines(1)

          const { buyVolume, sellVolume } = await getVolume(poolKeys.id.toBase58(), timesChecked)

          // console.log(`Take profit1: ${tp1} SOL | Take profit2: ${tp2} SOL  | Stop loss: ${sl} SOL | Buy amount: ${QUOTE_AMOUNT} SOL | Current: ${amountOut.toFixed(4)} SOL | PNL: ${pnl.toFixed(3)}%`)
          logger.info(`Current: ${amountOut.toFixed(5)} SOL | PNL: ${pnl.toFixed(5)}% | TP: ${SolOnTp} | SL: ${SolOnSl} | Lq: $${(liquidity.usd / 1000).toFixed(3)}K | MC: $${(marketCap / 1000).toFixed(3)}K | Price: $${Number(priceUsd).toFixed(3)} | 5M: ${priceChange_m5}% | 1H: ${priceChange_h1}% | TXs: ${(txns.h1.buys + txns.h1.sells)} | Buys: ${txns.h1.buys} | Sells: ${txns.h1.sells} | Vol: $${(volume_h1 / 1000).toFixed(3)}K ${(buyVolume && sellVolume) && `| Buy vol: $${buyVolume} | Sell vol: $${sellVolume}`}`)
        }
        const amountOutNum = Number(amountOut.toFixed(7))

        if (amountOutNum < SolOnSl) {
          logger.info("Token is on stop loss point, will sell with loss")
          break
        }

        if (amountOutNum > SolOnTp) {
          logger.info("Token is on profit level, selling tokens...")
          break
        }
      } catch (e) {
        // logger.info(".\n")
      } finally {
        timesChecked++
      }
      await sleep(priceCheckInterval)
    } while (timesChecked < timesToCheck)

  } catch (error) {
    logger.error("Error when setting profit amounts")
  }
}


