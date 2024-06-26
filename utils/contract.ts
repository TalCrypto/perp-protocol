import { Signer, BigNumber } from "ethers";
import { ethers, upgrades } from "hardhat";
import {
  AmmFake__factory,
  AmmFake,
  AmmMock,
  AmmMock__factory,
  AmmReader__factory,
  AmmReader,
  ClearingHouseFake__factory,
  ClearingHouseFake,
  ClearingHouseViewer__factory,
  ClearingHouseViewer,
  ERC20Fake__factory,
  ERC20Fake,
  InsuranceFundFake__factory,
  InsuranceFundFake,
  L2PriceFeedFake__factory,
  L2PriceFeedFake,
  L2PriceFeedMock,
  L2PriceFeedMock__factory,
  TollPool__factory,
  TollPool,
  Amm__factory,
  Amm,
  Liquidator,
  Liquidator__factory,
  ClearingHouse,
  ClearingHouse__factory,
  InsuranceFund,
  InsuranceFund__factory,
  ChainlinkPriceFeedFake,
  ChainlinkPriceFeedFake__factory,
  ChainlinkPriceFeed,
  ChainlinkPriceFeed__factory,
  ChainlinkAggregatorMock,
  ChainlinkAggregatorMock__factory,
  ETHStakingPool,
  ETHStakingPool__factory,
  ClearingHouseViewerMock__factory,
  ClearingHouseViewerMock,
  WhitelistMaster,
  WhitelistMaster__factory,
} from "../typechain-types";
import { toFullDigitBN } from "./number";

// const ERC20Fake = artifacts.require("ERC20Fake") as ERC20Fake__factory
// const AmmFake = artifacts.require("AmmFake") as AmmFake__factory
// const AmmReader = artifacts.require("AmmReader") as AmmReader__factory
// const ClearingHouseViewer = artifacts.require("ClearingHouseViewer") as ClearingHouseViewer__factory
// const ClearingHouseFake = artifacts.require("ClearingHouseFake") as ClearingHouseFake__factory
// const InsuranceFund = artifacts.require("InsuranceFundFake") as InsuranceFundFake__factory
// const L2PriceFeedFake = artifacts.require("L2PriceFeedFake") as L2PriceFeedFake__factory
// const TollPool = artifacts.require("TollPool") as TollPool__factory

export enum Side {
  BUY = 0,
  SELL = 1,
}

export enum Dir {
  ADD_TO_AMM = 0,
  REMOVE_FROM_AMM = 1,
}

export enum PnlCalcOption {
  SPOT_PRICE = 0,
  TWAP = 1,
}

export interface StakeBalance {
  totalBalance: number | BigNumber | string;
  stakeBalanceForCurrentEpoch: number | BigNumber | string;
  stakeBalanceForNextEpoch: number | BigNumber | string;
}

export interface EpochReward {
  reward: number | BigNumber | string;
  timeWeightedStake: number | BigNumber | string;
}

// typechain can't handle array of struct correctly, it will return every thing as string
// https://github.com/ethereum-ts/TypeChain/issues/139
export interface PositionCost {
  side: string;
  size: number | BigNumber | string;
  baseAssetReserve: number | BigNumber | string;
  quoteAssetReserve: number | BigNumber | string;
}

export interface AmmSettings {
  spreadRatio: number | BigNumber | string;
  tollRatio: number | BigNumber | string;
  tradeLimitRatio: number | BigNumber | string;
}

export interface AmmPrice {
  price: number | BigNumber | string;
  amount: number | BigNumber | string;
  fee: number | BigNumber | string;
  spread: number | BigNumber | string;
}

export async function deployAmm(params: {
  deployer: Signer;
  quoteAssetTokenAddr: string;
  priceFeedAddr: string;
  fluctuation: BigNumber;
  priceFeedKey?: string;
  fundingPeriod?: BigNumber;
  baseAssetReserve?: BigNumber;
  quoteAssetReserve?: BigNumber;
  tollRatio?: BigNumber;
  spreadRatio?: BigNumber;
}): Promise<AmmFake> {
  const {
    deployer,
    quoteAssetTokenAddr,
    priceFeedAddr,
    fluctuation,
    fundingPeriod = BigNumber.from(8 * 60 * 60), // 8hr
    baseAssetReserve = toFullDigitBN(100),
    quoteAssetReserve = toFullDigitBN(1000),
    priceFeedKey = "ETH",
    tollRatio = BigNumber.from(0),
    spreadRatio = BigNumber.from(0),
  } = params;
  return new AmmFake__factory(deployer).deploy(
    quoteAssetReserve.toString(),
    baseAssetReserve.toString(),
    toFullDigitBN(0.9).toString(), // tradeLimitRatio
    fundingPeriod.toString(),
    priceFeedAddr.toString(),
    ethers.utils.formatBytes32String(priceFeedKey),
    quoteAssetTokenAddr,
    fluctuation.toString(),
    tollRatio.toString(),
    spreadRatio.toString()
  );
}

export async function deployProxyAmm(params: {
  signer: Signer;
  quoteAssetReserve: BigNumber;
  baseAssetReserve: BigNumber;
  tradeLimitRatio: BigNumber;
  fundingPeriod: BigNumber;
  fluctuation: BigNumber;
  priceFeedKey: string;
  priceFeedAddress: string;
  tollRatio: BigNumber;
  spreadRatio: BigNumber;
  quoteTokenAddress: string;
}): Promise<Amm> {
  const instance = (await upgrades.deployProxy(new Amm__factory(params.signer), [
    params.quoteAssetReserve,
    params.baseAssetReserve,
    params.tradeLimitRatio,
    params.fundingPeriod,
    params.priceFeedAddress,
    params.priceFeedKey,
    params.quoteTokenAddress,
    params.fluctuation,
    params.tollRatio,
    params.spreadRatio,
  ])) as Amm;
  await instance.deployed();
  return instance;
}

export async function deployAmmReader(signer: Signer): Promise<AmmReader> {
  const instance = await new AmmReader__factory(signer).deploy();
  await instance.deployed();
  return instance;
}

export async function deployClearingHouse(signer: Signer, insuranceFund: string, trustedForwarder: string): Promise<ClearingHouseFake> {
  const instance = await new ClearingHouseFake__factory(signer).deploy(insuranceFund, trustedForwarder);
  return instance;
}

export async function deployProxyClearingHouse(signer: Signer, insuranceFund: string): Promise<ClearingHouse> {
  const instance = (await upgrades.deployProxy(new ClearingHouse__factory(signer), [insuranceFund])) as ClearingHouse;
  await instance.deployed();
  return instance;
}

export async function deployLiquidator(signer: Signer, clearingHouse: string): Promise<Liquidator> {
  const instance = (await upgrades.deployProxy(new Liquidator__factory(signer), [clearingHouse])) as Liquidator;
  await instance.deployed();
  return instance;
}

export async function deployClearingHouseViewer(signer: Signer, clearingHouse: string): Promise<ClearingHouseViewer> {
  const instance = await new ClearingHouseViewer__factory(signer).deploy(clearingHouse);
  await instance.deployed();
  return instance;
}

export async function deployClearingHouseViewerMock(signer: Signer, clearingHouse: string): Promise<ClearingHouseViewerMock> {
  const instance = await new ClearingHouseViewerMock__factory(signer).deploy(clearingHouse);
  await instance.deployed();
  return instance;
}

export async function deployErc20Fake(
  signer: Signer,
  initSupply: BigNumber = BigNumber.from(0),
  name = "name",
  symbol = "symbol",
  decimal: BigNumber = BigNumber.from(18)
): Promise<ERC20Fake> {
  const instance = await new ERC20Fake__factory(signer).deploy();
  await instance.initializeERC20Fake(initSupply.toString(), name, symbol, decimal.toString());
  return instance;
}

export async function deployInsuranceFund(signer: Signer, exchange: string, minter: string): Promise<InsuranceFundFake> {
  const instance = await new InsuranceFundFake__factory(signer).deploy();
  // await instance.initialize();
  // await instance.setExchange(exchange)
  // await instance.setMinter(minter)
  return instance;
}

export async function deployProxyIF(signer: Signer): Promise<InsuranceFund> {
  const instance = (await upgrades.deployProxy(new InsuranceFund__factory(signer), [])) as InsuranceFund;
  await instance.deployed();
  return instance;
}

export async function deployL2PriceFeed(signer: Signer, clientBridge: string, keeper: string): Promise<L2PriceFeedFake> {
  const instance = await new L2PriceFeedFake__factory(signer).deploy();
  await instance.initialize(clientBridge, keeper);
  return instance;
}

export async function deployL2MockPriceFeed(signer: Signer, defaultPrice: BigNumber): Promise<L2PriceFeedMock> {
  return new L2PriceFeedMock__factory(signer).deploy(defaultPrice.toString());
}

export async function deployTollPool(signer: Signer, clearingHouse: string): Promise<TollPool> {
  const instance = await new TollPool__factory(signer).deploy();
  await instance.initialize(clearingHouse);
  return instance;
}

export async function deployProxyTollPool(signer: Signer, clearingHouse: string): Promise<TollPool> {
  const instance = (await upgrades.deployProxy(new TollPool__factory(signer), [clearingHouse])) as TollPool;
  await instance.deployed();
  return instance;
}

export async function deployChainlinkPriceFeedFake(signer: Signer): Promise<ChainlinkPriceFeedFake> {
  const instance = await new ChainlinkPriceFeedFake__factory(signer).deploy();
  await instance.initialize();
  return instance;
}

export async function deployChainlinkPriceFeed(signer: Signer): Promise<ChainlinkPriceFeed> {
  const instance = (await upgrades.deployProxy(new ChainlinkPriceFeed__factory(signer), [])) as ChainlinkPriceFeed;
  await instance.deployed();
  return instance;
}

export async function deployChainlinkAggregatorMock(signer: Signer): Promise<ChainlinkAggregatorMock> {
  return new ChainlinkAggregatorMock__factory(signer).deploy();
}

export async function deployETHStakingPool(signer: Signer, quoteTokenAddr: string, insuranceFundAddr: string): Promise<ETHStakingPool> {
  const instance = (await upgrades.deployProxy(new ETHStakingPool__factory(signer), [quoteTokenAddr, insuranceFundAddr])) as ETHStakingPool;
  await instance.deployed();
  return instance;
}

export async function deployWhitelistMaster(signer: Signer): Promise<WhitelistMaster> {
  const instance = (await upgrades.deployProxy(new WhitelistMaster__factory(signer), [])) as WhitelistMaster;
  await instance.deployed();
  return instance;
}
