import { expect, use } from "chai";
import { Signer, BigNumber, ContractTransaction, BigNumberish } from "ethers";
import { ethers } from "hardhat";
import { solidity } from "ethereum-waffle";

import {
  ClearingHouse,
  AmmFake,
  ClearingHouseFake,
  ClearingHouseViewer,
  ERC20Fake,
  InsuranceFundFake,
  TraderWallet__factory,
  TraderWallet,
  L2PriceFeedMock,
  TollPool,
} from "../../../typechain-types";

import { PnlCalcOption, Side } from "../../../utils/contract";
import { fullDeploy } from "../../../utils/deploy";
import { toFullDigitBN } from "../../../utils/number";
import { SignerWithAddress } from "@nomiclabs/hardhat-ethers/signers";
import { loadFixture } from "@nomicfoundation/hardhat-network-helpers";

use(solidity);

type PositionChangedStruct = {
  trader?: string;
  amm?: string;
  margin?: BigNumberish;
  positionNotional?: BigNumberish;
  exchangedPositionSize?: BigNumberish;
  fee?: BigNumberish;
  positionSizeAfter?: BigNumberish;
  realizedPnl?: BigNumberish;
  unrealizedPnlAfter?: BigNumberish;
  badDebt?: BigNumberish;
  liquidationPenalty?: BigNumberish;
  spotPrice?: BigNumberish;
  fundingPayment?: BigNumberish;
};

describe("ClearingHouse - open/close position Test", () => {
  const MAX_INT = BigNumber.from(2).pow(BigNumber.from(255)).sub(BigNumber.from(1));
  let addresses: string[];
  let admin: SignerWithAddress;
  let alice: SignerWithAddress;
  let bob: SignerWithAddress;
  let carol: SignerWithAddress;
  let relayer: SignerWithAddress;

  let clearingHouse: ClearingHouseFake;
  let amm: AmmFake;
  let insuranceFund: InsuranceFundFake;
  let quoteToken: ERC20Fake;
  let clearingHouseViewer: ClearingHouseViewer;
  let tollPool: TollPool;
  let mockPriceFeed: L2PriceFeedMock;

  async function approve(account: SignerWithAddress, spender: string, amount: number | string): Promise<void> {
    await quoteToken.connect(account).approve(spender, toFullDigitBN(amount, +(await quoteToken.decimals())));
  }

  async function transfer(from: SignerWithAddress, to: string, amount: number | string): Promise<void> {
    await quoteToken.connect(from).transfer(to, toFullDigitBN(amount, +(await quoteToken.decimals())));
  }

  async function syncAmmPriceToOracle() {
    const marketPrice = await amm.getSpotPrice();
    await mockPriceFeed.setTwapPrice(marketPrice);
  }

  async function expectPositionChanged(tx: ContractTransaction, val: PositionChangedStruct) {
    const receipt = await tx.wait();
    const event = receipt.events?.find((x) => {
      return x.event == "PositionChanged";
    });
    expect(event?.args).to.not.be.null;
    if (val.trader != null) {
      expect(event?.args?.[0]).to.eq(val.trader);
    }
    if (val.amm != null) {
      expect(event?.args?.[1]).to.eq(val.amm);
    }
    if (val.margin != null) {
      expect(event?.args?.[2]).to.eq(val.margin);
    }
    if (val.positionNotional != null) {
      expect(event?.args?.[3]).to.eq(val.positionNotional);
    }
    if (val.exchangedPositionSize != null) {
      expect(event?.args?.[4]).to.eq(val.exchangedPositionSize);
    }
    if (val.fee != null) {
      expect(event?.args?.[5]).to.eq(val.fee);
    }
    if (val.positionSizeAfter != null) {
      expect(event?.args?.[6]).to.eq(val.positionSizeAfter);
    }
    if (val.realizedPnl != null) {
      expect(event?.args?.[7]).to.eq(val.realizedPnl);
    }
    if (val.unrealizedPnlAfter != null) {
      expect(event?.args?.[8]).to.eq(val.unrealizedPnlAfter);
    }
    if (val.badDebt != null) {
      expect(event?.args?.[9]).to.eq(val.badDebt);
    }
    if (val.liquidationPenalty != null) {
      expect(event?.args?.[10]).to.eq(val.liquidationPenalty);
    }
    if (val.spotPrice != null) {
      expect(event?.args?.[11]).to.eq(val.spotPrice);
    }
    if (val.fundingPayment != null) {
      expect(event?.args?.[12]).to.eq(val.fundingPayment);
    }
  }

  async function deployEnvFixture() {
    return fullDeploy({ sender: admin });
  }

  beforeEach(async () => {
    [admin, alice, bob, carol, relayer] = await ethers.getSigners();
    const contracts = await loadFixture(deployEnvFixture);
    amm = contracts.amm;
    insuranceFund = contracts.insuranceFund;
    quoteToken = contracts.quoteToken;
    clearingHouse = contracts.clearingHouse;
    clearingHouseViewer = contracts.clearingHouseViewer;
    clearingHouse = contracts.clearingHouse;
    tollPool = contracts.tollPool;
    mockPriceFeed = contracts.priceFeed;

    // Each of Alice & Bob have 5000 USDC
    await transfer(admin, alice.address, 5000);
    await transfer(admin, bob.address, 5000);
    await transfer(admin, insuranceFund.address, 5000);

    await syncAmmPriceToOracle();
  });

  describe("position", () => {
    beforeEach(async () => {
      await approve(alice, clearingHouse.address, 200);
      const clearingHouseBaseTokenBalance = await quoteToken.allowance(alice.address, clearingHouse.address);
      expect(clearingHouseBaseTokenBalance).eq(toFullDigitBN(200, +(await quoteToken.decimals())));
    });

    it("open position - long", async () => {
      // deposit to 2000
      await approve(alice, clearingHouse.address, 2000);

      await clearingHouse
        .connect(alice)
        .openPosition(amm.address, Side.BUY, toFullDigitBN(600), toFullDigitBN(10), toFullDigitBN(37.5), true);

      // expect to equal 60
      expect(await clearingHouseViewer.getPersonalBalanceWithFundingPayment(quoteToken.address, alice.address)).to.eq(toFullDigitBN(60));
      // personal position should be 37.5
      expect((await clearingHouse.getPosition(amm.address, alice.address)).size).to.eq(toFullDigitBN(37.5), "position not matched");
    });

    it("open position - two longs", async () => {
      // deposit to 2000
      await approve(alice, clearingHouse.address, 2000);
      // position 1
      // AMM after: 1600:62.5
      await clearingHouse.connect(alice).openPosition(amm.address, Side.BUY, toFullDigitBN(600), toFullDigitBN(10), toFullDigitBN(0), true);

      // position 2
      // AMM after: 2200:45.454545...
      await clearingHouse.connect(alice).openPosition(amm.address, Side.BUY, toFullDigitBN(600), toFullDigitBN(10), toFullDigitBN(0), true);

      // total size = 37.5 + 17.045454545 = 54.545454...
      const pos = await clearingHouse.getPosition(amm.address, alice.address);
      expect(pos.size).to.eq("54545454545454545454");
      expect(pos.margin).to.eq(toFullDigitBN(120));

      const margin = await clearingHouseViewer.getPersonalBalanceWithFundingPayment(quoteToken.address, alice.address);
      expect(margin).to.eq(toFullDigitBN(120));
    });

    it("open position - two shorts", async () => {
      // deposit to 2000
      await approve(alice, clearingHouse.address, 2000);

      // create position 1
      // AMM after: 800 : 125
      await clearingHouse
        .connect(alice)
        .openPosition(amm.address, Side.SELL, toFullDigitBN(200), toFullDigitBN(5), toFullDigitBN(25), true);

      // create position 2
      // AMM after: 600 : 166.6666666667
      await clearingHouse
        .connect(alice)
        .openPosition(amm.address, Side.SELL, toFullDigitBN(200), toFullDigitBN(5), toFullDigitBN(41.67), true);

      // total size = 25 + 41.6666 = 66.6666... and the size of short position is negative
      const pos2 = await clearingHouse.getPosition(amm.address, alice.address);
      expect(pos2.size).to.eq("-66666666666666666667");
      expect(pos2.margin).to.eq(toFullDigitBN(80));

      const margin = await clearingHouseViewer.getPersonalBalanceWithFundingPayment(quoteToken.address, alice.address);
      expect(margin).to.eq(toFullDigitBN(80));
    });

    it("open position - two equal size but opposite side positions", async () => {
      // deposit to 2000
      await approve(alice, clearingHouse.address, 2000);

      // create position 1
      // AMM after: 1600 : 62.5
      await clearingHouse
        .connect(alice)
        .openPosition(amm.address, Side.BUY, toFullDigitBN(600), toFullDigitBN(10), toFullDigitBN(37.5), true);
      // alice has 5000 - 60 = 4940
      expect(await quoteToken.balanceOf(alice.address)).to.eq(toFullDigitBN(4940, +(await quoteToken.decimals())));

      // create position 2
      // AMM after: 1000 : 100
      const ret = await clearingHouse
        .connect(alice)
        .openPosition(amm.address, Side.SELL, toFullDigitBN(600), toFullDigitBN(2), toFullDigitBN(37.5), true);

      const pos = await clearingHouse.connect(alice).getPosition(amm.address, alice.address);
      expect(pos.size).to.eq(0);
      expect(pos.margin).to.eq(toFullDigitBN(0));

      const margin = await clearingHouseViewer.getPersonalBalanceWithFundingPayment(quoteToken.address, alice.address);
      expect(margin).to.eq(toFullDigitBN(0));
    });

    it("open position - one long and two shorts", async () => {
      // deposit to 2000
      await approve(alice, clearingHouse.address, 2000);

      // create position 1 - long 60 * 10
      // AMM after: 1600 : 62.5
      await clearingHouse
        .connect(alice)
        .openPosition(amm.address, Side.BUY, toFullDigitBN(600), toFullDigitBN(10), toFullDigitBN(37.5), true);

      // create position 2 - short 20 * 5 (reduce position 100)
      // AMM after: 1500 : 66.6666...7
      const tx = await clearingHouse
        .connect(alice)
        .openPosition(amm.address, Side.SELL, toFullDigitBN(100), toFullDigitBN(5), toFullDigitBN(4.17), true);
      await expect(tx).to.emit(clearingHouse, "PositionChanged").withArgs(
        alice.address,
        amm.address,
        toFullDigitBN(60), //margin
        toFullDigitBN(100), //positionNotional
        "-4166666666666666667", //exchangedPositionSize
        toFullDigitBN(0), //fee
        "33333333333333333333", //position size
        toFullDigitBN(0), //realized pnl after
        toFullDigitBN(0), //unrealized pnl after
        toFullDigitBN(0), //bad debt
        0, //liquidationPenalty
        "22499999999999999999", //spot price
        toFullDigitBN(0) //funding payment
      );
      let pos = await clearingHouse.connect(alice).getPosition(amm.address, alice.address);
      expect(pos.size).to.eq("33333333333333333333");
      expect(pos.margin).to.eq(toFullDigitBN(60));

      expect(await clearingHouseViewer.getPersonalBalanceWithFundingPayment(quoteToken.address, alice.address)).to.eq(toFullDigitBN(60));

      // create position 3 - short
      // AMM after: 1000 : 100
      await clearingHouse
        .connect(alice)
        .openPosition(amm.address, Side.SELL, toFullDigitBN(500), toFullDigitBN(10), toFullDigitBN(33.34), true);
      pos = await clearingHouse.getPosition(amm.address, alice.address);
      expect(pos.size).to.eq(0);
      expect(pos.margin).to.eq(0);
      expect(await clearingHouseViewer.getPersonalBalanceWithFundingPayment(quoteToken.address, alice.address)).to.eq(0);
    });

    it("open position - short and two longs", async () => {
      // deposit to 2000
      await approve(alice, clearingHouse.address, 2000);

      // ## Current Amm Reserves:
      // BaseAsset=1000
      // QuoteAsset=100

      // create position 1 - short 40 * 5
      // AMM after: 800 : 125
      await clearingHouse
        .connect(alice)
        .openPosition(amm.address, Side.SELL, toFullDigitBN(200), toFullDigitBN(5), toFullDigitBN(25), true);

      // ## POSITION
      // size=-25
      // margin=40
      // openNotional=200
      // #### COSTS
      // - side=1
      // - size=25
      // - quoteAssetReserve=800
      // - baseAssetReserve=125

      //  ## Current Amm Reserves:
      //  BaseAsset=800
      //  QuoteAsset=125

      // create position 2 - long 20 * 5 (reduce position 100)
      // AMM after: 900 : 111.111...2
      await clearingHouse
        .connect(alice)
        .openPosition(amm.address, Side.BUY, toFullDigitBN(100), toFullDigitBN(5), toFullDigitBN(13.88), true);

      // ## POSITION
      // size=-11.111111111111111111
      // margin=20.000000000000000001
      // openNotional=100
      // #### COSTS
      // - side=1
      // - size=11.111111111111111111
      // - quoteAssetReserve=900
      // - baseAssetReserve=111.111111111111111111
      let pos = await clearingHouse.getPosition(amm.address, alice.address);
      expect(pos.size).to.eq("-11111111111111111112");
      expect(pos.margin).to.eq(toFullDigitBN(40));
      expect(await clearingHouseViewer.getPersonalBalanceWithFundingPayment(quoteToken.address, alice.address)).to.eq(toFullDigitBN(40));

      // ## Current Amm Reserves:
      // BaseAsset=900
      // QuoteAsset=111.111111111111111111

      // create position 3 - long
      // AMM after: 1000 : 100
      await clearingHouse.connect(alice).openPosition(amm.address, Side.BUY, toFullDigitBN(100), toFullDigitBN(10), toFullDigitBN(0), true);

      // there will be 1 wei dust size left
      pos = await clearingHouse.getPosition(amm.address, alice.address);
      expect(pos.size).to.eq(-1);
      expect(pos.margin).to.eq("39999999999999999993");
      expect(await clearingHouseViewer.getPersonalBalanceWithFundingPayment(quoteToken.address, alice.address)).to.eq(
        "39999999999999999993"
      );
    });

    it("open position - short, long and short", async () => {
      // avoid actions from exceeding the fluctuation limit
      await amm.setFluctuationLimitRatio(toFullDigitBN(0.8));

      // deposit to 2000
      await approve(alice, clearingHouse.address, 2000);

      // create position 1 - short
      // AMM after: 800 : 125
      await clearingHouse
        .connect(alice)
        .openPosition(amm.address, Side.SELL, toFullDigitBN(200), toFullDigitBN(10), toFullDigitBN(25), true);

      // create position 2 - long
      // AMM after: 1250: 80
      // return size might loss 1 wei
      await clearingHouse
        .connect(alice)
        .openPosition(amm.address, Side.BUY, toFullDigitBN(450), toFullDigitBN(3), toFullDigitBN(44.9), true);
      let pos = await clearingHouse.getPosition(amm.address, alice.address);

      // sumSize = -25 + 45 = 20
      // expect(pos.size).to.eq(toFullDigitBN(20))

      // sumMargin = sumNotionalSize((20 * 10) - 150 * 3) / leverage(3) = 83.33
      expect(pos.margin).to.eq("83333333333333333333");
      expect(await clearingHouseViewer.getPersonalBalanceWithFundingPayment(quoteToken.address, alice.address)).to.eq(
        "83333333333333333333"
      );

      // create position 3 - short
      // AMM after: 1000 : 100
      // return size might loss 1 wei
      await clearingHouse
        .connect(alice)
        .openPosition(amm.address, Side.SELL, toFullDigitBN(250), toFullDigitBN(10), toFullDigitBN(20), true);
      pos = await clearingHouse.getPosition(amm.address, alice.address);
      expect(pos.size).to.eq(0);
      expect(pos.margin).to.eq(0);

      const margin = await clearingHouseViewer.getPersonalBalanceWithFundingPayment(quoteToken.address, alice.address);
      expect(margin).to.eq(0);

      // 1916.666...7 = 2000 - 83.3333...
      expect(await quoteToken.allowance(alice.address, clearingHouse.address)).to.eq("1916666666666666666667");
      expect(await quoteToken.balanceOf(alice.address)).to.eq(toFullDigitBN(5000, +(await quoteToken.decimals())));
    });

    it("open position - long, short and long", async () => {
      // avoid actions from exceeding the fluctuation limit
      await amm.setFluctuationLimitRatio(toFullDigitBN(0.8));

      // deposit to 2000
      await approve(alice, clearingHouse.address, 2000);

      // create position 1 - long
      // AMM after: 1250 : 80
      await clearingHouse
        .connect(alice)
        .openPosition(amm.address, Side.BUY, toFullDigitBN(250), toFullDigitBN(10), toFullDigitBN(20), true);

      // create position 2 - short
      // AMM after: 800 : 125
      await clearingHouse.connect(alice).openPosition(amm.address, Side.SELL, toFullDigitBN(450), toFullDigitBN(3), toFullDigitBN(0), true);

      // sumSize = 20 - 45 = -25
      let pos = await clearingHouse.getPosition(amm.address, alice.address);
      expect(pos.size).to.eq(toFullDigitBN(-25));

      // sumMargin = sumNotionalSize(250 - 450) / leverage(3) = 66.66
      expect(pos.margin).to.eq("66666666666666666666");
      expect(await clearingHouseViewer.getPersonalBalanceWithFundingPayment(quoteToken.address, alice.address)).to.eq(
        "66666666666666666666"
      );

      // create position 3 - long
      // AMM after: 1000 : 100
      await clearingHouse.connect(alice).openPosition(amm.address, Side.BUY, toFullDigitBN(200), toFullDigitBN(10), toFullDigitBN(0), true);

      pos = await clearingHouse.getPosition(amm.address, alice.address);
      expect(pos.size).to.eq(0);
      expect(pos.margin).to.eq(0);
      const margin = await clearingHouseViewer.getPersonalBalanceWithFundingPayment(quoteToken.address, alice.address);
      expect(margin).to.eq(0);
    });

    it("pnl is 0 if no others are trading", async () => {
      await approve(alice, clearingHouse.address, 1000);
      await clearingHouse.connect(alice).openPosition(amm.address, Side.BUY, toFullDigitBN(250), toFullDigitBN(1), toFullDigitBN(0), true);
      await clearingHouse.connect(alice).openPosition(amm.address, Side.BUY, toFullDigitBN(750), toFullDigitBN(1), toFullDigitBN(0), true);

      const pnl = await clearingHouseViewer.getUnrealizedPnl(amm.address, alice.address, PnlCalcOption.SPOT_PRICE);
      expect(pnl).eq(0);
    });

    it("close a safe position", async () => {
      // deposit to 2000
      await approve(alice, clearingHouse.address, 2000);

      // AMM after 900 : 111.1111...
      await clearingHouse
        .connect(alice)
        .openPosition(amm.address, Side.SELL, toFullDigitBN(100), toFullDigitBN(2), toFullDigitBN(11.12), true);
      // personal position should be -11.111...
      expect((await clearingHouse.getPosition(amm.address, alice.address)).size).to.eq("-11111111111111111112");

      // ## POSITION
      // size=-11.111111111111111111
      // margin=50
      // openNotional=100
      // #### COSTS
      // - side=1
      // - size=11.111111111111111111
      // - quoteAssetReserve=900
      // - baseAssetReserve=111.111111111111111111
      let position = await clearingHouse.getPosition(amm.address, alice.address);

      // ## Current Amm Reserves:
      // BaseAsset=900
      // QuoteAsset=111.111111111111111111

      // Then Bob buy 60,  price will increase
      await approve(bob, clearingHouse.address, 2000);
      await clearingHouse.connect(bob).openPosition(amm.address, Side.BUY, toFullDigitBN(60), toFullDigitBN(6), toFullDigitBN(0), true);
      // base: 900 + 60 = 960, quote: 1000x100 / 960 = 104.166...7
      expect(await amm.quoteAssetReserve()).to.eq(toFullDigitBN(960));
      expect(await amm.baseAssetReserve()).to.eq("104166666666666666668");

      // ## Current Amm Reserves:
      // BaseAsset=960
      // QuoteAsset=104.166666666666666666

      /**
       * Now Alice's position is {balance: -11.1111111111, margin: 50, openNotional: 100}
       * if closePosition, it means Alice create a opposite position which is BUY 11.1111111111 quoteAsset
       * (960 + baseAssetAmount) * (104.1666666667 - 11.1111111111) = 1000 * 100 => baseAssetAmount = 114.6268656711
       * Alice will get (100 - 114.6268656711) = -14.6268656711 loss
       * free margin and add profit to Alice's balance
       * all balance = allBalance(2000) + profit(-14.6268656711) = 1985.3731343289
       * margin balance = 0
       * free balance = all balance = 1985.3731343289
       */
      await clearingHouse.connect(alice).closePosition(amm.address, toFullDigitBN(0));

      // ## POSITION
      // size=0
      // margin=0
      // openNotional=0
      // #### COSTS
      position = await clearingHouse.getPosition(amm.address, alice.address);

      expect(position.size).to.eq(0);
      expect(await amm.quoteAssetReserve()).to.eq("1074626865671641791054");
      expect(await amm.baseAssetReserve()).to.eq("93055555555555555556");
    });

    it("close a position which is slightly over maintenanceMarginRatio", async () => {
      // deposit to 2000
      await approve(alice, clearingHouse.address, 2000);

      // AMM after 1250 : 80...
      await clearingHouse.connect(alice).openPosition(amm.address, Side.BUY, toFullDigitBN(250), toFullDigitBN(10), toFullDigitBN(0), true);
      // personal position should be 20
      expect((await clearingHouse.getPosition(amm.address, alice.address)).size).to.eq(toFullDigitBN(20));

      // Then Bob short 35.08,  price will decrease
      // AMM after 1214.92 : 82.31
      await approve(bob, clearingHouse.address, 2000);
      await clearingHouse.connect(bob).openPosition(amm.address, Side.SELL, toFullDigitBN(35.08), toFullDigitBN(1), toFullDigitBN(0), true);

      /**
       * Now Alice's position is {margin: 25}
       * positionValue of 20 quoteAsset is 237.5 now
       * marginRatio = (margin(25) + unrealizedPnl(237.5-250)) / openNotionalSize(250) = 5%
       */
      await clearingHouse.connect(alice).closePosition(amm.address, toFullDigitBN(0));

      // AMM after 977.42 : 102.31
      // Alice's realizedPnl = 237.5 - 250 = -12.5
      // balance = approved(2000) + realizedPnl(-12.5) = 1987.5
      const position = await clearingHouse.getPosition(amm.address, alice.address);
      expect(position.size).to.eq(0);
      expect(await amm.quoteAssetReserve()).to.eq("977422074620429546963");
      expect(await amm.baseAssetReserve()).to.eq("102309946333914990288");
      const margin = await clearingHouseViewer.getPersonalBalanceWithFundingPayment(quoteToken.address, alice.address);

      expect(margin).to.eq(0);
    });

    it("cannot close position with bad debt", async () => {
      // deposit to 2000
      await approve(alice, clearingHouse.address, 2000);

      // AMM after 1250 : 80...
      await clearingHouse.connect(alice).openPosition(amm.address, Side.BUY, toFullDigitBN(250), toFullDigitBN(10), toFullDigitBN(0), true);
      // personal position should be 20
      expect((await clearingHouse.getPosition(amm.address, alice.address)).size).to.eq(toFullDigitBN(20));

      // Then Bob short 250,  price will decrease
      await approve(bob, clearingHouse.address, 2000);
      await clearingHouse.connect(bob).openPosition(amm.address, Side.SELL, toFullDigitBN(250), toFullDigitBN(1), toFullDigitBN(0), true);

      /**
       * Now Alice's position is {balance: 20, margin: 25}
       * positionValue of 20 quoteAsset is 166.67 now
       * marginRatio = (margin(25) + unrealizedPnl(166.67-250)) / openNotionalSize(250) = -23%
       */
      await expect(clearingHouse.connect(alice).closePosition(amm.address, toFullDigitBN(0))).to.be.revertedWith("bad debt");
    });

    it("close an empty position", async () => {
      await expect(clearingHouse.connect(alice).closePosition(amm.address, toFullDigitBN(0))).to.be.revertedWith("positionSize is 0");
    });

    it("open/close position to check the fee is charged", async () => {
      await amm.setTollRatio(toFullDigitBN(0.01));
      await amm.setSpreadRatio(toFullDigitBN(0.02));

      // deposit to 2000
      await approve(alice, clearingHouse.address, 2000);

      await clearingHouse.connect(alice).openPosition(amm.address, Side.BUY, toFullDigitBN(600), toFullDigitBN(10), toFullDigitBN(0), true);
      expect(await quoteToken.balanceOf(clearingHouse.address)).to.eq(toFullDigitBN(60, +(await quoteToken.decimals())));

      // clearingHouse's balance = 60 - 60(alice's margin) = 0
      // fee balance in tollPool = 6 + 6 = 12
      // spread balance in insuranceFund = 12 + 12 = 24
      await clearingHouse.connect(alice).closePosition(amm.address, toFullDigitBN(0));
      expect(await quoteToken.balanceOf(clearingHouse.address)).to.eq(toFullDigitBN(0, +(await quoteToken.decimals())));

      expect(await quoteToken.balanceOf(insuranceFund.address)).to.eq(toFullDigitBN(5024, +(await quoteToken.decimals())));
      expect(await quoteToken.balanceOf(tollPool.address)).to.eq(toFullDigitBN(12, +(await quoteToken.decimals())));
    });

    it("open/close position to check the fee is charged; tollRatio changed to 1% from 5%", async () => {
      await amm.setTollRatio(toFullDigitBN(0.01));

      // deposit to 2000
      await approve(alice, clearingHouse.address, 2000);

      await clearingHouse.connect(alice).openPosition(amm.address, Side.BUY, toFullDigitBN(600), toFullDigitBN(10), toFullDigitBN(0), true);
      expect(await quoteToken.balanceOf(tollPool.address)).to.eq(toFullDigitBN(6, +(await quoteToken.decimals())));

      await amm.setTollRatio(toFullDigitBN(0.05));
      await clearingHouse.connect(alice).openPosition(amm.address, Side.BUY, toFullDigitBN(200), toFullDigitBN(10), toFullDigitBN(0), true);

      expect(await quoteToken.balanceOf(tollPool.address)).to.eq(toFullDigitBN(16, +(await quoteToken.decimals())));

      await clearingHouse.connect(alice).closePosition(amm.address, toFullDigitBN(0));
      expect(await quoteToken.balanceOf(tollPool.address)).to.eq("55999999999999999999"); // ~=56
    });

    it("check PositionChanged event by opening and then closing a position", async () => {
      // deposit to 2000
      await amm.setTollRatio(toFullDigitBN(0.01));
      await approve(alice, clearingHouse.address, 2000);

      // AMM after 900 : 111.1111...
      const txOpen = await clearingHouse
        .connect(alice)
        .openPosition(amm.address, Side.SELL, toFullDigitBN(100), toFullDigitBN(2), toFullDigitBN(11.12), true);

      await expectPositionChanged(txOpen, {
        trader: alice.address,
        amm: amm.address,
        margin: toFullDigitBN(50),
        positionNotional: toFullDigitBN(100),
        exchangedPositionSize: "-11111111111111111112",
        fee: toFullDigitBN(1), // notional size 100 * 1% = 1
        positionSizeAfter: "-11111111111111111112",
        realizedPnl: "0",
      });

      const txClose = await clearingHouse.connect(alice).closePosition(amm.address, toFullDigitBN(0));

      await expectPositionChanged(txClose, {
        trader: alice.address,
        amm: amm.address,
        margin: "0",
        positionNotional: "100000000000000000008",
        exchangedPositionSize: "11111111111111111112",
        fee: "1000000000000000000",
        positionSizeAfter: toFullDigitBN(0),
      });

      const position = await clearingHouse.getPosition(amm.address, alice.address);
      expect(position.size).to.eq(0);
    });

    it("check PositionChanged event by open 2 opposite side positions with the same size", async () => {
      // deposit to 2000
      await approve(alice, clearingHouse.address, 2000);

      // AMM after 900 : 111.1111...
      const receiptOpen = await clearingHouse
        .connect(alice)
        .openPosition(amm.address, Side.SELL, toFullDigitBN(100), toFullDigitBN(2), toFullDigitBN(11.12), true);

      await expectPositionChanged(receiptOpen, {
        trader: alice.address,
        amm: amm.address,
        positionNotional: toFullDigitBN(100),
        exchangedPositionSize: "-11111111111111111112",
        fee: toFullDigitBN(0),
        positionSizeAfter: "-11111111111111111112",
        realizedPnl: "0",
      });

      enum Dir {
        ADD_TO_AMM = 0,
        REMOVE_FROM_AMM = 1,
      }
      const amount = await amm.getOutputPrice(Dir.REMOVE_FROM_AMM, "11111111111111111111");
      const receiptOpen2 = await clearingHouse
        .connect(alice)
        .openPosition(amm.address, Side.BUY, amount, toFullDigitBN(1), toFullDigitBN(0), true);

      await expectPositionChanged(receiptOpen2, {
        trader: alice.address,
        amm: amm.address,
        positionNotional: amount,
        exchangedPositionSize: "11111111111111111111",
        fee: toFullDigitBN(0),
        positionSizeAfter: "-1",
      });
    });

    it("check PositionChanged event by open a smaller opposite side position", async () => {
      // deposit to 2000
      await approve(alice, clearingHouse.address, 2000);

      // AMM after 900 : 111.1111...
      await clearingHouse
        .connect(alice)
        .openPosition(amm.address, Side.SELL, toFullDigitBN(100), toFullDigitBN(2), toFullDigitBN(11.12), true);

      const receiptOpen2 = await clearingHouse
        .connect(alice)
        .openPosition(amm.address, Side.BUY, toFullDigitBN(50), toFullDigitBN(1), toFullDigitBN(0), true);

      await expectPositionChanged(receiptOpen2, {
        trader: alice.address,
        amm: amm.address,
        positionNotional: toFullDigitBN(50),
        exchangedPositionSize: "5847953216374269005",
        fee: toFullDigitBN(0),
        positionSizeAfter: "-5263157894736842107",
      });
    });

    it("check exchangedPositionSize in PositionChanged event by opening a lager reverse long", async () => {
      // deposit to 2000
      await approve(alice, clearingHouse.address, 2000);

      // got -11.11 position size
      await clearingHouse
        .connect(alice)
        .openPosition(amm.address, Side.SELL, toFullDigitBN(100), toFullDigitBN(2), toFullDigitBN(11.12), true);

      // got 24.155 position size
      const receipt = await clearingHouse
        .connect(alice)
        .openPosition(amm.address, Side.BUY, toFullDigitBN(250), toFullDigitBN(5), toFullDigitBN(0), true);

      await expectPositionChanged(receipt, {
        positionNotional: toFullDigitBN(250),
        exchangedPositionSize: "24154589371980676328",
        positionSizeAfter: "13043478260869565216",
      });
    });

    it("check exchangedPositionSize in PositionChanged event by opening a lager reverse short", async () => {
      // deposit to 2000
      await approve(alice, clearingHouse.address, 2000);

      // got 9.09 position size
      await clearingHouse.connect(alice).openPosition(amm.address, Side.BUY, toFullDigitBN(100), toFullDigitBN(2), toFullDigitBN(0), true);

      // got -26.738 position size
      const receipt = await clearingHouse
        .connect(alice)
        .openPosition(amm.address, Side.SELL, toFullDigitBN(250), toFullDigitBN(5), toFullDigitBN(0), true);

      await expectPositionChanged(receipt, {
        positionNotional: toFullDigitBN(250),
        exchangedPositionSize: "-26737967914438502674",
        positionSizeAfter: "-17647058823529411765",
      });
    });

    it.skip("alice open position, bob open another position, alice reduce position and update margin by closedPnl", async () => {
      // deposit to 2000
      await approve(alice, clearingHouse.address, 2000);
      await approve(bob, clearingHouse.address, 2000);

      // alice trade 37.5 contract for 60 * 10 quoteToken
      await clearingHouse
        .connect(alice)
        .openPosition(amm.address, Side.BUY, toFullDigitBN(600), toFullDigitBN(10), toFullDigitBN(37.5), true);
      // bob trade 12.5 contract for 40 * 10 quoteToken
      await clearingHouse
        .connect(bob)
        .openPosition(amm.address, Side.BUY, toFullDigitBN(400), toFullDigitBN(10), toFullDigitBN(12.5), true);

      // now alice has unrealizedPnl 257.14
      // then alice reduce position for 400 quoteToken (equals to 12.5 contract)
      const receipt = await clearingHouse
        .connect(alice)
        .openPosition(amm.address, Side.SELL, toFullDigitBN(400), toFullDigitBN(1), toFullDigitBN(12.5), true);

      await expectPositionChanged(receipt, {
        trader: alice.address,
        amm: amm.address,
        positionNotional: toFullDigitBN(400),
        exchangedPositionSize: toFullDigitBN(-12.5),
        fee: toFullDigitBN(0),
        positionSizeAfter: toFullDigitBN(25),
        realizedPnl: "0",
        badDebt: "0",
      });

      // because her marginRatio is high enough that she doesn't need to keep any margin
      const balance = await clearingHouseViewer.getPersonalBalanceWithFundingPayment(quoteToken.address, alice.address);
      expect(balance).eq(toFullDigitBN(0));
    });

    it.skip("alice open position, bob open another position, alice open reverse position with larger size");

    it("pnl - unrealized", async () => {
      // deposit to 2000
      await approve(alice, clearingHouse.address, 2000);
      await approve(bob, clearingHouse.address, 2000);
      // Alice's Balance in clearingHouse: 2000
      // (1000 + x) * (100 + y) = 1000 * 100
      //
      // Alice long by 25 base token with leverage 10x to get 20 ptoken
      // 25 * 10 = 250 which is x
      // (1000 + 250) * (100 + y) = 1000 * 100
      // so y = -20
      await clearingHouse
        .connect(alice)
        .openPosition(amm.address, Side.BUY, toFullDigitBN(250), toFullDigitBN(10), toFullDigitBN(20), true);

      // Bob's balance in clearingHouse: 2000
      // current equation is:
      // (1250 + x) * (80 + y) = 1000 * 100
      // Bob short by 100 base token with leverage 10x to get -320 ptoken
      // 100 * 10 = 1000 which is x
      // (1250 - 1000) * (80 + y) = 1000 * 100
      // so y = 320
      //
      // and current equation is :
      // (250 + x) * (400 + y) = 1000 * 100
      await clearingHouse
        .connect(bob)
        .openPosition(amm.address, Side.SELL, toFullDigitBN(1000), toFullDigitBN(10), toFullDigitBN(320), true);

      const pos = await clearingHouse.getPosition(amm.address, alice.address);
      expect(pos.size).to.eq(toFullDigitBN(20));

      // calculate Alice's unrealized PNL:
      // Alice has position 20 ptoken, so
      // (250 + x) * (400 + 20) = 1000 * 100
      // x = -11.9047619048
      // alice will get 11.9047619048 if she close position
      // since Alice use 250 to buy
      // 11.9047619048 - 250 = -238.0952380952 which is unrealized PNL.
      const alicePnl = await clearingHouseViewer.getUnrealizedPnl(amm.address, alice.address, PnlCalcOption.SPOT_PRICE);
      expect(alicePnl).to.eq("-238095238095238095239");
    });

    it("Force error, open position - not enough balance", async () => {
      await clearingHouse.connect(alice).openPosition(amm.address, Side.BUY, toFullDigitBN(600), toFullDigitBN(10), toFullDigitBN(0), true);

      await expect(
        clearingHouse.connect(alice).openPosition(amm.address, Side.BUY, toFullDigitBN(1410), toFullDigitBN(10), toFullDigitBN(0), true)
      ).to.be.revertedWith("STF");
    });

    it("Force error, open position - exceed margin ratio", async () => {
      await expect(
        clearingHouse.connect(alice).openPosition(amm.address, Side.SELL, toFullDigitBN(1260), toFullDigitBN(21), toFullDigitBN(37.5), true)
      ).to.be.revertedWith("Margin ratio not meet criteria");
    });

    it("alice take profit from bob's unrealized under-collateral position, then bob close", async () => {
      // avoid actions from exceeding the fluctuation limit
      await amm.setFluctuationLimitRatio(toFullDigitBN(0.8));

      // alice opens short position
      await approve(alice, clearingHouse.address, 20);
      await clearingHouse
        .connect(alice)
        .openPosition(amm.address, Side.SELL, toFullDigitBN(200), toFullDigitBN(10), toFullDigitBN(0), true);

      // bob opens short position
      await approve(bob, clearingHouse.address, 20);
      await clearingHouse.connect(bob).openPosition(amm.address, Side.SELL, toFullDigitBN(200), toFullDigitBN(10), toFullDigitBN(0), true);

      // alice close position, pnl = 200 -105.88 ~= 94.12
      // receive pnl + margin = 114.12

      // depositPool only has 40, ask insuranceFund to pre-pay extra badDebt 114.12 - 40 = 74.12

      await expect(clearingHouse.connect(alice).closePosition(amm.address, toFullDigitBN(0)))
        .to.emit(quoteToken, "Transfer")
        .withArgs(insuranceFund.address, clearingHouse.address, "74117647058823529412");

      expect(await quoteToken.balanceOf(clearingHouse.address)).eq(0);
      expect(await clearingHouse.getPrepaidBadDebt(amm.address)).eq("74117647058823529412");

      // bob close her under collateral position, positionValue is -294.11
      // bob's pnl = 200 - 294.11 ~= -94.12
      // bob loss all her margin (20) with additional 74.12 badDebt
      // which is already prepaid by insurance fund when alice close the position before
      // clearing house don't need to ask insurance fund for covering the bad debt
      const bobMarginRatio = await clearingHouse.connect(bob).getMarginRatio(amm.address, bob.address);
      expect(bobMarginRatio.isNegative()).eq(true);
      await clearingHouse.setBackstopLiquidityProvider(bob.address, true);
      await clearingHouse.connect(bob).liquidate(amm.address, bob.address);

      // clearingHouse is depleted
      expect(await quoteToken.balanceOf(clearingHouse.address)).eq(3);
    });

    it("alice take profit from bob's unrealized under-collateral position, then bob got liquidate", async () => {
      await clearingHouse.setBackstopLiquidityProvider(carol.address, true);

      // avoid actions from exceeding the fluctuation limit
      await amm.setFluctuationLimitRatio(toFullDigitBN(0.8));

      // alice opens short position
      await approve(alice, clearingHouse.address, 20);
      await clearingHouse
        .connect(alice)
        .openPosition(amm.address, Side.SELL, toFullDigitBN(200), toFullDigitBN(10), toFullDigitBN(0), true);

      // bob opens short position
      await approve(bob, clearingHouse.address, 20);
      await clearingHouse.connect(bob).openPosition(amm.address, Side.SELL, toFullDigitBN(200), toFullDigitBN(10), toFullDigitBN(0), true);

      // alice close position, pnl = 200 -105.88 ~= 94.12
      // receive pnl + margin = 114.12

      // depositPool only has 40, ask insuranceFund to pre-pay extra badDebt 114.12 - 40 = 74.12

      await expect(clearingHouse.connect(alice).closePosition(amm.address, toFullDigitBN(0)))
        .to.emit(quoteToken, "Transfer")
        .withArgs(insuranceFund.address, clearingHouse.address, "74117647058823529412");

      expect(await quoteToken.balanceOf(clearingHouse.address)).eq(0);
      expect(await clearingHouse.getPrepaidBadDebt(amm.address)).eq("74117647058823529412");

      // keeper liquidate bob's under collateral position, bob's positionValue is -294.11
      // bob's pnl = 200 - 294.11 ~= -94.12
      // bob loss all her margin (20) and there's 74.12 badDebt
      // which is already prepaid by insurance fund when alice close the position
      const bobMarginRatio = await clearingHouse.getMarginRatio(amm.address, bob.address);
      expect(bobMarginRatio.isNegative()).eq(true);
      await clearingHouse.connect(carol).liquidateWithSlippage(amm.address, bob.address, 0);

      // liquidator get half of the 5% liquidation fee = 294.11 * 2.5% ~= 7.352941
      // clearingHouse is depleted
      expect(await quoteToken.balanceOf(clearingHouse.address)).eq(3);
      expect(await quoteToken.balanceOf(carol.address)).eq("7352941176470588235");
    });

    // the test for pointing out the calculation of margin ratio should be based on positionNotional instead of openNotional
    it("alice's position has enough margin left, thus won't get liquidated", async () => {
      // alice opens long position
      await approve(alice, clearingHouse.address, 300);
      await clearingHouse.connect(alice).openPosition(amm.address, Side.BUY, toFullDigitBN(600), toFullDigitBN(2), toFullDigitBN(0), true);

      // bob opens short position
      await approve(bob, clearingHouse.address, 500);
      await clearingHouse.connect(bob).openPosition(amm.address, Side.SELL, toFullDigitBN(500), toFullDigitBN(1), toFullDigitBN(0), true);

      // unrealizedPnl: -278.77
      // positionNotional: 600 - 278.77 = 321.23
      // remainMargin: 300 - 278.77 = 21.23
      // liquidationFee: 321.23 * 5% = 16.06
      // margin ratio: = (margin + unrealizedPnl) / positionNotional = 21.23 / 321.23 = 6.608971765%
      await expect(clearingHouse.connect(carol).liquidateWithSlippage(amm.address, alice.address, 0)).to.be.revertedWith(
        "Margin ratio not meet criteria"
      );
    });

    it("alice's position got liquidated and not enough margin left for paying liquidation fee", async () => {
      await clearingHouse.setBackstopLiquidityProvider(carol.address, true);

      // alice opens long position
      await approve(alice, clearingHouse.address, 150);
      await clearingHouse.connect(alice).openPosition(amm.address, Side.BUY, toFullDigitBN(600), toFullDigitBN(4), toFullDigitBN(0), true);

      // bob opens short position
      await approve(bob, clearingHouse.address, 500);
      await clearingHouse.connect(bob).openPosition(amm.address, Side.SELL, toFullDigitBN(500), toFullDigitBN(1), toFullDigitBN(0), true);

      // alice's margin ratio = (margin + unrealizedPnl) / openNotional = (150 + (-278.77)) / 600 = -21.46%

      const tx = await clearingHouse.connect(carol).liquidateWithSlippage(amm.address, alice.address, 0);

      // liquidationFee = 321.23 * 2.5% = 16.06
      // the "liquidationFee" of PositionLiquidated event refers to liquidator's fee: 16.06 * 0.5 = 8.03
      // remainMargin = margin + unrealizedPnl = 150 + (-278.77) = -128.77
      // Since -128.77 - 16.06 < 0
      //   position changed badDebt = 128.77
      //   liquidation badDebt = 8.03
      // Trader total liquidation penalty = -278.77 + 128.77 = -150

      await expectPositionChanged(tx, {
        realizedPnl: "-278761061946902654868",
        badDebt: "128761061946902654868",
        liquidationPenalty: "150000000000000000000",
      });

      const receipt = await tx.wait();
      const event = receipt.events?.find((x) => {
        return x.event == "PositionLiquidated";
      });

      expect(event?.args?.[4]).to.eq("8030973451327433628");
      expect(event?.args?.[6]).to.eq("8030973451327433628");
    });

    // it("alice's long position margin ratio is underwater, but oracle price kicked in, thus won't get liquidated", async () => {
    //   // alice opens long position
    //   // AMM after 1600 : 62.5
    //   // spot price = 25.6
    //   // openNotional = 600
    //   // position size = 37.5
    //   // margin = 150
    //   await approve(alice, clearingHouse.address, 150);
    //   await clearingHouse.connect(alice).openPosition(amm.address, Side.BUY, toFullDigitBN(150), toFullDigitBN(4), toFullDigitBN(0));

    //   await syncAmmPriceToOracle(); // oracle price = 25.6

    //   // bob opens short position
    //   // AMM after 1100 : 90.90909
    //   // spot price = 12.1
    //   await approve(bob, clearingHouse.address, 500);
    //   await clearingHouse.connect(bob).openPosition(amm.address, Side.SELL, toFullDigitBN(500), toFullDigitBN(1), toFullDigitBN(0));

    //   // alice's margin ratio = (margin + unrealizedPnl) / openNotional = (150 + (-278.77)) / 600 = -21.46%

    //   // however, oracle price is more than 10% higher than spot ((25.6 - 12.1) / 12.1 = 111.570247%)
    //   //   price = 25.6
    //   //   position notional = 25.6 * 37.5 = 960
    //   //   unrealizedPnl = 960 - 600 = 360
    //   //   margin ratio = (150 + 360) / 960 = 53.125% (won't liquidate)
    //   await expect(clearingHouse.connect(carol).liquidateWithSlippage(amm.address, alice.address, 0)).to.be.revertedWith(
    //     "Margin ratio not meet criteria"
    //   );
    // });

    // it("alice's short position margin ratio is underwater, but oracle price kicked in, thus won't get liquidated", async () => {
    //   // alice opens long position
    //   // AMM after 800 : 125
    //   // spot price = 6.4
    //   // openNotional = 200
    //   // position size = -25
    //   // margin = 20
    //   await approve(alice, clearingHouse.address, 20);
    //   await clearingHouse.connect(alice).openPosition(amm.address, Side.SELL, toFullDigitBN(20), toFullDigitBN(10), toFullDigitBN(0));

    //   await syncAmmPriceToOracle(); // oracle price = 6.4

    //   // bob opens short position
    //   // AMM after 900 : 111.111111
    //   // spot price = 8.1
    //   await approve(bob, clearingHouse.address, 20);
    //   await clearingHouse.connect(bob).openPosition(amm.address, Side.BUY, toFullDigitBN(10), toFullDigitBN(10), toFullDigitBN(0));

    //   // alice:
    //   //   positionNotional = 100000 / (111.111111 - 25) - 900 = 261.290324
    //   //   unrealizedPnl = 200 - 261.290324 = -61.290324
    //   // alice's margin ratio = (margin + unrealizedPnl) / openNotional = (20 + (-61.290324)) / 261.290324 = -15.802469%

    //   // however, oracle price is more than 10% lower than spot ((6.4 - 8.1) / 8.1 = -20.987654%)
    //   //   price = 6.4
    //   //   position notional = 25 * 6.4 = 160
    //   //   unrealizedPnl = 200 - 160 = 40
    //   //   margin ratio = (20 + 40) / 160 = 37.5% (won't liquidate)
    //   await expect(clearingHouse.connect(carol).liquidateWithSlippage(amm.address, alice.address, 0)).to.be.revertedWith(
    //     "Margin ratio not meet criteria"
    //   );
    // });

    it("can open position of the same side even though position(long) is underwater, as long as the margin ratio will be over maintenance ratio after the action", async () => {
      await approve(alice, clearingHouse.address, 2000);
      await approve(bob, clearingHouse.address, 2000);

      // alice gets 20 position
      await clearingHouse.connect(alice).openPosition(amm.address, Side.BUY, toFullDigitBN(250), toFullDigitBN(10), toFullDigitBN(0), true);
      // AMM after 1250 : 80

      await clearingHouse.connect(bob).openPosition(amm.address, Side.SELL, toFullDigitBN(250), toFullDigitBN(1), toFullDigitBN(0), true);
      // AMM after 1000 : 100

      /**
       * position size = 20
       * margin = 25
       * positionNotional = 166.67
       * openNotional = 250
       * unrealizedPnl = 166.67 - 250 = -83.33
       * marginRatio = (25 + -83.33) / 250 = -23%
       */
      await clearingHouse.connect(alice).openPosition(amm.address, Side.BUY, toFullDigitBN(100), toFullDigitBN(1), toFullDigitBN(0), true);

      /*
       * AMM after 1100 : 90.90909
       * positionNotional = 166.67 + 100 = 266.67
       * position size = 20 + 9.09 = 29.09
       * margin = 25 + 100
       */
      expect((await clearingHouse.getPosition(amm.address, alice.address)).margin).to.eq("125000000000000000000");
      expect((await clearingHouse.getPosition(amm.address, alice.address)).size).to.eq("29090909090909090909");
      expect((await clearingHouse.getPositionNotionalAndUnrealizedPnl(amm.address, alice.address, PnlCalcOption.SPOT_PRICE))[0]).to.eq(
        "266666666666666666665"
      );
    });

    it("can open reverse position even though position(long) is underwater, as long as the margin ratio will be over maintenance ratio after the action", async () => {
      await approve(alice, clearingHouse.address, 2000);
      await approve(bob, clearingHouse.address, 2000);

      // alice gets about 20 position
      await clearingHouse
        .connect(alice)
        .openPosition(amm.address, Side.BUY, toFullDigitBN(250.008), toFullDigitBN(2.841), toFullDigitBN(0), true);
      expect((await clearingHouse.getPosition(amm.address, alice.address)).margin).to.eq(toFullDigitBN(88));
      // AMM after 1250 : 80

      await clearingHouse.connect(bob).openPosition(amm.address, Side.SELL, toFullDigitBN(250), toFullDigitBN(1), toFullDigitBN(0), true);
      // AMM after 1000 : 100

      /**
       * position size = 20
       * margin = 88
       * positionNotional = 166.67
       * openNotional ~= 250
       * unrealizedPnl = 166.67 - 250 = -83.33
       * marginRatio = (88 + -83.33) / 250 = 1.868%
       */
      await clearingHouse.connect(alice).openPosition(amm.address, Side.SELL, toFullDigitBN(150), toFullDigitBN(1), toFullDigitBN(0), true);

      /**
       * AMM after 850 : 117.64705882
       * positionNotional = 166.67 - 150 = 16.67
       * position size = 20 - 17.64705882 = 2.35
       * realizedPnl = -83.33 * (20 - 2.35) / 20 = -73.538725
       * margin = 88 -73.538725 ~= 14.4
       */
      expect((await clearingHouse.getPosition(amm.address, alice.address)).size).to.eq("2353760435608511085");
      expect((await clearingHouse.getPosition(amm.address, alice.address)).margin).to.eq("14471986140208919751");
      expect((await clearingHouse.getPositionNotionalAndUnrealizedPnl(amm.address, alice.address, PnlCalcOption.SPOT_PRICE))[0]).to.eq(
        "16672666683555438214"
      );
    });

    it("force error, cannot open position if position(long) is underwater and will still be after the action", async () => {
      // deposit to 2000
      await approve(alice, clearingHouse.address, 2000);
      await approve(bob, clearingHouse.address, 2000);

      // AMM after 1250 : 80...
      // position 20
      await clearingHouse.connect(alice).openPosition(amm.address, Side.BUY, toFullDigitBN(250), toFullDigitBN(10), toFullDigitBN(0), true);

      // Then Bob short 250,  price will decrease
      await clearingHouse.connect(bob).openPosition(amm.address, Side.SELL, toFullDigitBN(250), toFullDigitBN(1), toFullDigitBN(0), true);

      /**
       * Now Alice's position is {balance: 20, margin: 25}
       * positionValue of 20 quoteAsset is 166.67 now
       * marginRatio = (margin(25) + unrealizedPnl(166.67-250)) / openNotionalSize(250) = -23%
       */
      await expect(
        clearingHouse.connect(alice).openPosition(amm.address, Side.BUY, toFullDigitBN(1), toFullDigitBN(1), toFullDigitBN(0), true)
      ).to.be.revertedWith("Margin ratio not meet criteria");

      await expect(
        clearingHouse.connect(alice).openPosition(amm.address, Side.SELL, toFullDigitBN(1), toFullDigitBN(1), toFullDigitBN(0), true)
      ).to.be.revertedWith("Margin ratio not meet criteria");
    });

    it("force error, cannot open position if position(short) is underwater and will still be after the action", async () => {
      // deposit to 2000
      await approve(alice, clearingHouse.address, 2000);
      await approve(bob, clearingHouse.address, 2000);

      // AMM after 125 : 80...
      // position 25
      await clearingHouse
        .connect(alice)
        .openPosition(amm.address, Side.SELL, toFullDigitBN(200), toFullDigitBN(10), toFullDigitBN(0), true);
      await clearingHouse.connect(bob).openPosition(amm.address, Side.BUY, toFullDigitBN(200), toFullDigitBN(10), toFullDigitBN(0), true);

      // Now Alice's position is underwater, cant increase position
      await expect(
        clearingHouse.connect(alice).openPosition(amm.address, Side.SELL, toFullDigitBN(1), toFullDigitBN(1), toFullDigitBN(0), true)
      ).to.be.revertedWith("Margin ratio not meet criteria");
    });

    describe("close partial position", () => {
      async function forwardBlockTimestamp(time: number): Promise<void> {
        const now = await amm.mock_getCurrentTimestamp();
        const newTime = now.add(time);
        await clearingHouse.mock_setBlockTimestamp(newTime);
        const movedBlocks = time / 15 < 1 ? 1 : time / 15;

        const blockNumber = await amm.mock_getCurrentBlockNumber();
        const newBlockNumber = blockNumber.add(movedBlocks);
        await clearingHouse.mock_setBlockNumber(newBlockNumber);
      }

      beforeEach(async () => {
        await clearingHouse.setPartialLiquidationRatio(toFullDigitBN(0.25));
        await approve(alice, clearingHouse.address, 100);
      });

      // it("partially close a long position when closing whole position will over fluctuation limit ", async () => {
      //   // AMM after: 1250 : 80, price: 15.625
      //   await clearingHouse
      //     .connect(alice)
      //     .openPosition(amm.address, Side.BUY, toFullDigitBN(250), toFullDigitBN(10), toFullDigitBN(0), true);
      //   await forwardBlockTimestamp(15);

      //   await amm.setSpreadRatio(toFullDigitBN(0.001));
      //   await amm.setFluctuationLimitRatio(toFullDigitBN(0.359));
      //   // the price will be dropped to 10 if we close whole position
      //   // the price fluctuation will be (15.625 - 10) / 15.625 = 0.36
      //   // only 25% position (20 * 0.25 = 5) will be closed,
      //   // position notional is 73.53
      //   // amm reserves after 1176.47 : 85
      //   const receipt = await clearingHouse.connect(alice).closePosition(amm.address, toFullDigitBN(0));
      //   const pos = await clearingHouse.getPosition(amm.address, alice.address);
      //   expect(pos.size).eq(toFullDigitBN(15));
      //   expect(pos.margin).eq(toFullDigitBN(25));

      //   await expectPositionChanged(receipt, {
      //     trader: alice.address,
      //     amm: amm.address,
      //     positionNotional: "73529411764705882352",
      //     margin: toFullDigitBN(25),
      //     exchangedPositionSize: toFullDigitBN(-5),
      //     fee: "73529411764705882",
      //     positionSizeAfter: toFullDigitBN(15),
      //   });

      //   // 5000 - open pos margin (25) + fee (-73.53 * 0.1%)
      //   expect(await quoteToken.balanceOf(alice.address)).eq("4974926470588235294118");
      // });

      // it("partially close a short position when closing whole position will over fluctuation limit ", async () => {
      //   // AMM after: 800 : 125, price: 6.4
      //   await clearingHouse
      //     .connect(alice)
      //     .openPosition(amm.address, Side.SELL, toFullDigitBN(200), toFullDigitBN(10), toFullDigitBN(0), true);
      //   await forwardBlockTimestamp(15);
      //   const posAfterOpen = await clearingHouse.getPosition(amm.address, alice.address);
      //   expect(posAfterOpen.size).eq(toFullDigitBN(-25));

      //   await amm.setSpreadRatio(toFullDigitBN(0.001));
      //   await amm.setFluctuationLimitRatio(toFullDigitBN(0.5624));
      //   // the price will be dropped to 10 if we close whole position
      //   // the price fluctuation will be (10 - 6.4) / 6.4 = 0.5625
      //   // only 25% position (25 * 0.25 = 6.25) will be closed,
      //   // position notional is 42.11
      //   // amm reserves after 842.11 : 118.75
      //   const receipt = await clearingHouse.connect(alice).closePosition(amm.address, toFullDigitBN(0));

      //   const pos = await clearingHouse.getPosition(amm.address, alice.address);
      //   expect(pos.size).eq(toFullDigitBN(-18.75));
      //   expect(pos.margin).eq(toFullDigitBN(20));

      //   await expectPositionChanged(receipt, {
      //     trader: alice.address,
      //     amm: amm.address,
      //     positionNotional: "42105263157894736843",
      //     margin: toFullDigitBN(20),
      //     exchangedPositionSize: toFullDigitBN(6.25), // 25 * 0.25
      //     fee: "42105263157894736",
      //     positionSizeAfter: toFullDigitBN(-18.75), // position size - partial closed position size
      //   });
      // });

      it("should fail to close whole position when over fluctuation limit", async () => {
        // AMM after: 1250 : 80, price: 15.625
        await clearingHouse
          .connect(alice)
          .openPosition(amm.address, Side.BUY, toFullDigitBN(250), toFullDigitBN(10), toFullDigitBN(0), true);
        await forwardBlockTimestamp(15);

        await amm.setFluctuationLimitRatio(toFullDigitBN(0.359));
        // await clearingHouse.setPartialLiquidationRatio(toFullDigitBN(1));
        await expect(clearingHouse.connect(alice).closePosition(amm.address, toFullDigitBN(0))).to.be.revertedWith(
          "price is over fluctuation limit"
        );
        // const receipt = await clearingHouse.connect(alice).closePosition(amm.address, toFullDigitBN(0));
        // const pos = await clearingHouse.getPosition(amm.address, alice.address);
        // expect(pos.size).eq(toFullDigitBN(0));
        // expect(pos.margin).eq(toFullDigitBN(0));
        // expect(await quoteToken.balanceOf(alice.address)).eq(toFullDigitBN(5000, +(await quoteToken.decimals())));
      });
    });

    describe("quote amount is at the boundary of minimum value of USDC (10 ^ -6)", () => {
      describe("valid token amount (>= 10 ^ -6)", () => {
        it("openPosition", async () => {
          await expect(
            clearingHouse.connect(alice).openPosition(amm.address, Side.BUY, toFullDigitBN(1e-6), toFullDigitBN(1), toFullDigitBN(0), true)
          ).to.emit(clearingHouse, "PositionChanged");
        });

        it("addMargin", async () => {
          await clearingHouse
            .connect(alice)
            .openPosition(amm.address, Side.BUY, toFullDigitBN(1), toFullDigitBN(1), toFullDigitBN(0), true);

          await expect(clearingHouse.connect(alice).addMargin(amm.address, toFullDigitBN(1e-6))).to.emit(clearingHouse, "MarginChanged");
        });

        it("removeMargin", async () => {
          await clearingHouse
            .connect(alice)
            .openPosition(amm.address, Side.BUY, toFullDigitBN(1), toFullDigitBN(1), toFullDigitBN(0), true);
          await expect(clearingHouse.connect(alice).removeMargin(amm.address, toFullDigitBN(1e-6))).to.emit(clearingHouse, "MarginChanged");
        });
      });

      //   describe("force error, the token amount is invalid/too small (< 10 ^ -6)", () => {
      //     it("openPosition", async () => {
      //       await expect(clearingHouse.connect(alice).openPosition(amm.address, Side.BUY, toFullDigitBN("0.9e-6"), toFullDigitBN(10), toFullDigitBN(0)))
      //         .to.be.revertedWith("invalid token amount");
      //     });

      //     it("addMargin", async () => {
      //       // can addMargin even if there is no position opened yet
      //       await expect(clearingHouse.connect(alice).addMargin(amm.address, toFullDigitBN("0.9e-6"))).to.be.revertedWith("invalid token amount");
      //     });

      //     it("removeMargin", async () => {
      //       // cannot removeMargin if there is no position opened yet
      //       // thus, have to open a position first
      //       await clearingHouse.connect(alice).openPosition(amm.address, Side.BUY, toFullDigitBN(1), toFullDigitBN(1), toFullDigitBN(0));

      //       await expect(clearingHouse.connect(alice).removeMargin(amm.address, toFullDigitBN("0.9e-6"))).to.be.revertedWith("invalid token amount");
      //     });
      //   });
    });
  });

  describe("position upper bound", () => {
    beforeEach(async () => {
      await amm.setCap(toFullDigitBN(10), toFullDigitBN(0));
      await approve(alice, clearingHouse.address, 1000);
    });

    it("open a long and a smaller short position under limit", async () => {
      // position size is 9.9
      await expect(
        clearingHouse.connect(alice).openPosition(amm.address, Side.BUY, toFullDigitBN(110), toFullDigitBN(1), toFullDigitBN(0), true)
      ).to.emit(clearingHouse, "PositionChanged");

      await expect(
        clearingHouse.connect(alice).openPosition(amm.address, Side.SELL, toFullDigitBN(50), toFullDigitBN(1), toFullDigitBN(0), true)
      ).to.emit(clearingHouse, "PositionChanged");
    });

    it("open two long positions under limit", async () => {
      await expect(
        clearingHouse.connect(alice).openPosition(amm.address, Side.BUY, toFullDigitBN(55), toFullDigitBN(1), toFullDigitBN(0), true)
      ).to.emit(clearingHouse, "PositionChanged");

      await expect(
        clearingHouse.connect(alice).openPosition(amm.address, Side.BUY, toFullDigitBN(55), toFullDigitBN(1), toFullDigitBN(0), true)
      ).to.emit(clearingHouse, "PositionChanged");
    });

    it("open a short position and a smaller long under limit", async () => {
      // position size is -9.89
      await expect(
        clearingHouse.connect(alice).openPosition(amm.address, Side.SELL, toFullDigitBN(90), toFullDigitBN(1), toFullDigitBN(0), true)
      ).to.emit(clearingHouse, "PositionChanged");

      await expect(
        clearingHouse.connect(alice).openPosition(amm.address, Side.BUY, toFullDigitBN(50), toFullDigitBN(1), toFullDigitBN(0), true)
      ).to.emit(clearingHouse, "PositionChanged");
    });

    it("open two short positions under limit", async () => {
      await expect(
        clearingHouse.connect(alice).openPosition(amm.address, Side.SELL, toFullDigitBN(45), toFullDigitBN(1), toFullDigitBN(0), true)
      ).to.emit(clearingHouse, "PositionChanged");

      await expect(
        await clearingHouse.connect(alice).openPosition(amm.address, Side.SELL, toFullDigitBN(45), toFullDigitBN(1), toFullDigitBN(0), true)
      ).to.emit(clearingHouse, "PositionChanged");
    });

    it("change position size upper bound and open positions", async () => {
      await amm.setCap(toFullDigitBN(20), toFullDigitBN(0));

      // position size is 20
      await expect(
        clearingHouse.connect(alice).openPosition(amm.address, Side.BUY, toFullDigitBN(250), toFullDigitBN(10), toFullDigitBN(0), true)
      ).to.emit(clearingHouse, "PositionChanged");
      await clearingHouse.connect(alice).closePosition(amm.address, toFullDigitBN(0));

      // position size is -19.05
      await expect(
        clearingHouse.connect(alice).openPosition(amm.address, Side.SELL, toFullDigitBN(160), toFullDigitBN(10), toFullDigitBN(0), true)
      ).to.emit(clearingHouse, "PositionChanged");
    });

    it("force error, open a long position and over the limit", async () => {
      // position size is 10.7
      await expect(
        clearingHouse.connect(alice).openPosition(amm.address, Side.BUY, toFullDigitBN(120), toFullDigitBN(1), toFullDigitBN(0), true)
      ).to.be.revertedWith("hit position size upper bound");
    });

    it("force error, open long positions and over the limit", async () => {
      // position size is 10.7
      await clearingHouse.connect(alice).openPosition(amm.address, Side.BUY, toFullDigitBN(60), toFullDigitBN(1), toFullDigitBN(0), true);

      await expect(
        clearingHouse.connect(alice).openPosition(amm.address, Side.BUY, toFullDigitBN(60), toFullDigitBN(1), toFullDigitBN(0), true)
      ).to.be.revertedWith("hit position size upper bound");
    });

    it("force error, open a short position and over the limit", async () => {
      // position size is -10.5
      await expect(
        clearingHouse.connect(alice).openPosition(amm.address, Side.SELL, toFullDigitBN(95), toFullDigitBN(1), toFullDigitBN(0), true)
      ).to.be.revertedWith("hit position size upper bound");
    });

    it("force error, open short positions and over the limit", async () => {
      // position size is -10.5
      await clearingHouse.connect(alice).openPosition(amm.address, Side.SELL, toFullDigitBN(45), toFullDigitBN(1), toFullDigitBN(0), true);

      await expect(
        clearingHouse.connect(alice).openPosition(amm.address, Side.SELL, toFullDigitBN(50), toFullDigitBN(1), toFullDigitBN(0), true)
      ).to.be.revertedWith("hit position size upper bound");
    });

    it("force error, open a long and a larger reverse short and over the limit", async () => {
      // position size is 9.09
      await clearingHouse.connect(alice).openPosition(amm.address, Side.BUY, toFullDigitBN(100), toFullDigitBN(10), toFullDigitBN(0), true);

      // position size would be -10.2, revert
      await expect(
        clearingHouse.connect(alice).openPosition(amm.address, Side.SELL, toFullDigitBN(200), toFullDigitBN(10), toFullDigitBN(0), true)
      ).to.be.revertedWith("hit position size upper bound");
    });

    it("force error, open a short and a larger reverse long and over the limit", async () => {
      // position size is -9.89
      await clearingHouse.connect(alice).openPosition(amm.address, Side.SELL, toFullDigitBN(90), toFullDigitBN(10), toFullDigitBN(0), true);

      // position size would be 10.7, revert
      await expect(
        clearingHouse.connect(alice).openPosition(amm.address, Side.BUY, toFullDigitBN(210), toFullDigitBN(10), toFullDigitBN(0), true)
      ).to.be.revertedWith("hit position size upper bound");
    });

    describe("whitelisting", () => {
      it("add whitelists, and open a long which larger than the limit", async () => {
        await clearingHouse.setWhitelist(alice.address);

        // position size is 10.7
        await expect(
          clearingHouse.connect(alice).openPosition(amm.address, Side.BUY, toFullDigitBN(120), toFullDigitBN(1), toFullDigitBN(0), true)
        ).to.emit(clearingHouse, "PositionChanged");
      });

      it("add whitelists, and open a short, a larger reverse long", async () => {
        await clearingHouse.setWhitelist(alice.address);
        // position size is -9.89
        await clearingHouse
          .connect(alice)
          .openPosition(amm.address, Side.SELL, toFullDigitBN(90), toFullDigitBN(10), toFullDigitBN(0), true);

        // position size would be 10.7, revert
        await expect(
          clearingHouse.connect(alice).openPosition(amm.address, Side.BUY, toFullDigitBN(210), toFullDigitBN(10), toFullDigitBN(0), true)
        ).to.emit(clearingHouse, "PositionChanged");
      });

      it("remove from whitelist, open a long and a larger reverse short", async () => {
        await clearingHouse.setWhitelist(alice.address);
        // position size is 10.7
        await clearingHouse
          .connect(alice)
          .openPosition(amm.address, Side.BUY, toFullDigitBN(120), toFullDigitBN(1), toFullDigitBN(0), true);

        await clearingHouse.setWhitelist("0x0000000000000000000000000000000000000000");
        // position size would be -14.9, revert
        await expect(
          clearingHouse.connect(alice).openPosition(amm.address, Side.SELL, toFullDigitBN(250), toFullDigitBN(10), toFullDigitBN(0), true)
        ).to.be.revertedWith("hit position size upper bound");
      });

      it("remove from whitelist and add back", async () => {
        await clearingHouse.setWhitelist(alice.address);
        // position size is 10.7
        await clearingHouse
          .connect(alice)
          .openPosition(amm.address, Side.BUY, toFullDigitBN(120), toFullDigitBN(1), toFullDigitBN(0), true);

        await clearingHouse.setWhitelist("0x0000000000000000000000000000000000000000");
        // position size would be -14.9, revert
        await expect(
          clearingHouse.connect(alice).openPosition(amm.address, Side.SELL, toFullDigitBN(250), toFullDigitBN(10), toFullDigitBN(0), true)
        ).to.be.revertedWith("hit position size upper bound");

        await clearingHouse.setWhitelist(alice.address);
        await expect(
          clearingHouse.connect(alice).openPosition(amm.address, Side.SELL, toFullDigitBN(250), toFullDigitBN(10), toFullDigitBN(0), true)
        ).to.emit(clearingHouse, "PositionChanged");
      });
    });
  });

  describe("fee calculation", () => {
    beforeEach(async () => {
      await amm.setTollRatio(toFullDigitBN(0.05));
      await amm.setSpreadRatio(toFullDigitBN(0.05));
      await amm.setCap(toFullDigitBN(0), toFullDigitBN(0));
    });

    it("open position when total fee is 10%", async () => {
      await approve(alice, clearingHouse.address, 360);

      // given 300 x 2 quote asset, get 37.5 base asset
      // fee is 300 x 2 x 10% = 60
      // user needs to pay 300 + 60 = 360
      const receipt = await clearingHouse
        .connect(alice)
        .openPosition(amm.address, Side.BUY, toFullDigitBN(600), toFullDigitBN(2), toFullDigitBN(37.5), true);
      await expectPositionChanged(receipt, {
        trader: alice.address,
        amm: amm.address,
        positionNotional: toFullDigitBN(600), // 300x2
        exchangedPositionSize: toFullDigitBN(37.5),
        fee: toFullDigitBN(60),
        positionSizeAfter: toFullDigitBN(37.5),
        realizedPnl: "0",
      });

      expect(await clearingHouseViewer.getPersonalBalanceWithFundingPayment(quoteToken.address, alice.address)).to.eq(toFullDigitBN(300));
      expect(await quoteToken.balanceOf(clearingHouse.address)).to.eq(toFullDigitBN(300, +(await quoteToken.decimals())));

      // fee 30, spread 30
      expect(await quoteToken.balanceOf(tollPool.address)).to.eq(toFullDigitBN(30, +(await quoteToken.decimals())));
      expect(await quoteToken.balanceOf(insuranceFund.address)).to.eq(toFullDigitBN(5030, +(await quoteToken.decimals())));
    });

    it("open short position twice when total fee is 10%", async () => {
      await approve(alice, clearingHouse.address, 360);

      // given 50 x 2 quote asset, get 11.1 base asset
      // fee is 50 x 2 x 10% = 10
      // user needs to pay 50 + 10 = 60
      await clearingHouse
        .connect(alice)
        .openPosition(amm.address, Side.SELL, toFullDigitBN(100), toFullDigitBN(2), toFullDigitBN(11.2), true);
      const aliceBalance1 = await quoteToken.balanceOf(alice.address);

      const receipt = await clearingHouse
        .connect(alice)
        .openPosition(amm.address, Side.SELL, toFullDigitBN(100), toFullDigitBN(2), toFullDigitBN(139), true);
      const aliceBalance2 = await quoteToken.balanceOf(alice.address);

      await expectPositionChanged(receipt, {
        trader: alice.address,
        amm: amm.address,
        positionNotional: toFullDigitBN(100),
        exchangedPositionSize: "-13888888888888888889",
        fee: toFullDigitBN(10),
        positionSizeAfter: "-25000000000000000001",
        realizedPnl: "0",
      });

      expect(aliceBalance2.sub(aliceBalance1)).eq(toFullDigitBN(-60, +(await quoteToken.decimals())));

      expect(await quoteToken.balanceOf(clearingHouse.address)).to.eq(toFullDigitBN(100, +(await quoteToken.decimals())));
      expect(await quoteToken.balanceOf(tollPool.address)).to.eq(toFullDigitBN(10, +(await quoteToken.decimals())));
      expect(await quoteToken.balanceOf(insuranceFund.address)).to.eq(toFullDigitBN(5010, +(await quoteToken.decimals())));
    });

    it("open and close position when total fee is 10%", async () => {
      await approve(alice, clearingHouse.address, 2000);

      await clearingHouse
        .connect(alice)
        .openPosition(amm.address, Side.BUY, toFullDigitBN(600), toFullDigitBN(2), toFullDigitBN(37.5), true);

      // when alice close her entire position
      const receipt = await clearingHouse.connect(alice).closePosition(amm.address, toFullDigitBN(0));

      // then 37.5 contract worth 600 quoteAsset (openNotional doesn't change because no other trade)
      // strike will take fees after traded with amm, fee = 600 * 10% = 60
      // alice actual get 600 - 60 = 540 when closing her entire 37.5 position

      await expectPositionChanged(receipt, {
        trader: alice.address,
        amm: amm.address,
        positionNotional: toFullDigitBN(600),
        exchangedPositionSize: toFullDigitBN(-37.5),
        fee: toFullDigitBN(60),
        positionSizeAfter: toFullDigitBN(0),
        realizedPnl: "0",
      });

      // feePool = 60 (fee of opening the position) + 60 (fee of closing the position)
      expect(await quoteToken.balanceOf(clearingHouse.address)).to.eq(toFullDigitBN(0, +(await quoteToken.decimals())));
      expect(await quoteToken.balanceOf(tollPool.address)).to.eq(toFullDigitBN(60, +(await quoteToken.decimals())));
      expect(await quoteToken.balanceOf(insuranceFund.address)).to.eq(toFullDigitBN(5060, +(await quoteToken.decimals())));
    });

    it("open position and close manually by opening reverse position(long then short) when fee is 10%", async () => {
      await approve(alice, clearingHouse.address, 420);

      await clearingHouse.connect(alice).openPosition(amm.address, Side.BUY, toFullDigitBN(600), toFullDigitBN(2), toFullDigitBN(0), true);

      const positionNotional = (
        await clearingHouse.getPositionNotionalAndUnrealizedPnl(amm.address, alice.address, PnlCalcOption.SPOT_PRICE)
      )[0];

      // alice need 600 to close her 37.5 position, she opens a reverse position to close manually
      // and she doesn't need to increase quoteToken's balance or allowance
      const receipt = await clearingHouse
        .connect(alice)
        .openPosition(amm.address, Side.SELL, positionNotional, toFullDigitBN(1), toFullDigitBN(0), true);

      // then 37.5 contract worth 600 quoteAsset (openNotional doesn't change because no other trade)

      await expectPositionChanged(receipt, {
        trader: alice.address,
        amm: amm.address,
        positionNotional: toFullDigitBN(600),
        exchangedPositionSize: toFullDigitBN(-37.5),
        fee: toFullDigitBN(60),
        positionSizeAfter: toFullDigitBN(0),
        realizedPnl: "0",
      });

      // 1st tx fee = 300 * 2 * 5% = 30
      // 1st tx spread = 300 * 2 * 5% = 30
      // 2nd tx fee = 300 * 2 * 5% = 30
      // 2nd tx fee = 300 * 2 * 5% = 30
      expect(await quoteToken.balanceOf(tollPool.address)).to.eq(toFullDigitBN(60, +(await quoteToken.decimals())));
      expect(await quoteToken.balanceOf(insuranceFund.address)).to.eq(toFullDigitBN(5060, +(await quoteToken.decimals())));
    });

    it("open position and close manually by opening reverse position(short then long) when fee is 10%", async () => {
      await approve(alice, clearingHouse.address, 420);

      await clearingHouse.connect(alice).openPosition(amm.address, Side.SELL, toFullDigitBN(600), toFullDigitBN(2), toFullDigitBN(0), true);

      const positionNotional = (
        await clearingHouse.getPositionNotionalAndUnrealizedPnl(amm.address, alice.address, PnlCalcOption.SPOT_PRICE)
      )[0];

      // alice need 600 to close her 37.5 position, she opens a reverse position to close manually
      // and she doesn't need to increase quoteToken's balance or allowance
      const receipt = await clearingHouse
        .connect(alice)
        .openPosition(amm.address, Side.BUY, positionNotional, toFullDigitBN(1), toFullDigitBN(0), true);

      // then 37.5 contract worth 600 quoteAsset (openNotional doesn't change because no other trade)
      await expectPositionChanged(receipt, {
        trader: alice.address,
        amm: amm.address,
        positionNotional: toFullDigitBN(600),
        exchangedPositionSize: toFullDigitBN(150),
        fee: toFullDigitBN(60),
        positionSizeAfter: toFullDigitBN(0),
        realizedPnl: "0",
      });

      // 1st tx fee = 300 * 2 * 5% = 30
      // 1st tx spread = 300 * 2 * 5% = 30
      // 2nd tx fee = 300 * 2 * 5% = 30
      // 2nd tx fee = 300 * 2 * 5% = 30

      expect(await quoteToken.balanceOf(tollPool.address)).to.eq(toFullDigitBN(60, +(await quoteToken.decimals())));
      expect(await quoteToken.balanceOf(insuranceFund.address)).to.eq(toFullDigitBN(5060, +(await quoteToken.decimals())));
    });

    it("close a under collateral position when fee is 10%", async () => {
      await clearingHouse.setBackstopLiquidityProvider(bob.address, true);

      await approve(alice, clearingHouse.address, 60); // 20(first margin) + 20(open fee) + 17.04(close fee)
      await approve(bob, clearingHouse.address, 2000);

      await clearingHouse.connect(alice).openPosition(amm.address, Side.BUY, toFullDigitBN(200), toFullDigitBN(10), toFullDigitBN(0), true);

      // bob short position to let Alice PnL is negative
      await clearingHouse.connect(bob).openPosition(amm.address, Side.SELL, toFullDigitBN(100), toFullDigitBN(10), toFullDigitBN(0), true);

      // alice PnL is -29.577464788732394365
      // can only liquidate her without fee incurred
      await clearingHouse.connect(bob).liquidate(amm.address, alice.address);

      // fee is 10 + 5 = 15
      expect(await quoteToken.balanceOf(tollPool.address)).to.eq("15000000000000000000");
    });

    it("force error, not enough balance to open position when total fee is 10%", async () => {
      await approve(alice, clearingHouse.address, 359);

      // given 300 x 2 quote asset, get 37.5 base asset
      // fee is 300 x 2 x 10% = 60
      // user needs to pay 300 + 60 = 360, but only has 359
      await expect(
        clearingHouse.connect(alice).openPosition(amm.address, Side.BUY, toFullDigitBN(600), toFullDigitBN(2), toFullDigitBN(37.5), true)
      ).to.be.revertedWith("STF");
    });

    it("has spread but no toll", async () => {
      await amm.setSpreadRatio(toFullDigitBN(0.1));
      await amm.setTollRatio(toFullDigitBN(0));

      await approve(alice, clearingHouse.address, 360);
      const receipt = await clearingHouse
        .connect(alice)
        .openPosition(amm.address, Side.BUY, toFullDigitBN(600), toFullDigitBN(2), toFullDigitBN(0), true);
      await expectPositionChanged(receipt, {
        trader: alice.address,
        amm: amm.address,
        positionNotional: toFullDigitBN(600), // 300x2
        exchangedPositionSize: toFullDigitBN(37.5),
        fee: toFullDigitBN(60),
        positionSizeAfter: toFullDigitBN(37.5),
        realizedPnl: "0",
      });

      expect(await quoteToken.balanceOf(tollPool.address)).to.eq(toFullDigitBN(0, +(await quoteToken.decimals())));
      expect(await quoteToken.balanceOf(insuranceFund.address)).to.eq(toFullDigitBN(5060, +(await quoteToken.decimals())));
    });
  });

  describe("traded with 10% fee amm, check size, margin and openNotional", () => {
    beforeEach(async () => {
      // unlock alice and bob's quoteToken for clearingHouse (clearingHouse)
      await approve(alice, clearingHouse.address, "1000000");
      await approve(bob, clearingHouse.address, "1000000");

      // 10% fee
      await amm.setTollRatio(toFullDigitBN(0.1));
      await amm.setSpreadRatio(toFullDigitBN(0));
      await amm.setCap(toFullDigitBN(0), toFullDigitBN(0));
    });

    describe("open position", () => {
      it("open long position", async () => {
        // alice opens long position with 60 margin, 10x leverage
        // (1000 + 600) * (100 + baseAssetDelta) = 100k, baseAssetDelta = -37.5
        const receipt = await clearingHouse
          .connect(alice)
          .openPosition(amm.address, Side.BUY, toFullDigitBN(600), toFullDigitBN(10), toFullDigitBN(37.5), true);

        // transferred margin = margin + fee = 60 + (60 * 10 * 10%) = 120
        const position = await clearingHouse.getPosition(amm.address, alice.address);
        expect(position.size).to.eq(toFullDigitBN(37.5));
        expect(position.openNotional).to.eq(toFullDigitBN(600));
        expect(position.margin).to.eq(toFullDigitBN(60));

        expect(await quoteToken.balanceOf(clearingHouse.address)).eq(toFullDigitBN(60, +(await quoteToken.decimals())));
        expect(await quoteToken.balanceOf(tollPool.address)).to.eq(toFullDigitBN(60, +(await quoteToken.decimals())));
      });

      it("open short position", async () => {
        // alice opens short position with 60 margin, 10x leverage
        // (1000 - 600) * (100 + baseAssetDelta) = 100k, baseAssetDelta = 150
        const receipt = await clearingHouse
          .connect(alice)
          .openPosition(amm.address, Side.SELL, toFullDigitBN(600), toFullDigitBN(10), toFullDigitBN(150), true);

        // transferred margin = margin + fee = 60 + (60 * 10 * 10%) = 120
        const position = await clearingHouse.getPosition(amm.address, alice.address);
        expect(position.size).to.eq(toFullDigitBN(-150));
        expect(position.openNotional).to.eq(toFullDigitBN(600));
        expect(position.margin).to.eq(toFullDigitBN(60));

        expect(await quoteToken.balanceOf(clearingHouse.address)).eq(toFullDigitBN(60, +(await quoteToken.decimals())));
        expect(await quoteToken.balanceOf(tollPool.address)).to.eq(toFullDigitBN(60, +(await quoteToken.decimals())));
      });
    });

    describe("increase position", () => {
      it("open long position, price remains, then long again", async () => {
        // alice opens long position with 25 margin, 10x leverage
        // (1000 + 250) * (100 + baseAssetDelta) = 100k, baseAssetDelta = -20
        await clearingHouse
          .connect(alice)
          .openPosition(amm.address, Side.BUY, toFullDigitBN(250), toFullDigitBN(10), toFullDigitBN(20), true);
        const aliceBalance1 = await quoteToken.balanceOf(alice.address);

        // alice opens long position with 175 margin, 2x leverage
        // (1250 + 350) * (80 + baseAssetDelta) = 100k, baseAssetDelta = -17.5
        const receipt = await clearingHouse
          .connect(alice)
          .openPosition(amm.address, Side.BUY, toFullDigitBN(350), toFullDigitBN(2), toFullDigitBN(17.5), true);
        const aliceBalance2 = await quoteToken.balanceOf(alice.address);

        // transferred margin = margin + fee = 175 + (175 * 2 * 10%) = 210
        expect(aliceBalance2.sub(aliceBalance1)).eq(toFullDigitBN(-210, +(await quoteToken.decimals())));

        const position = await clearingHouse.getPosition(amm.address, alice.address);
        // total position size = 20 + 17.5 = 37.5
        expect(position.size).to.eq(toFullDigitBN(37.5));
        // open notional = 250 + 350 = 600
        expect(position.openNotional).to.eq(toFullDigitBN(600));
        // total position margin = 25 + 175 = 200
        expect(position.margin).to.eq(toFullDigitBN(200));
        // pnl = 0 because no other trader
        expect(await clearingHouseViewer.getUnrealizedPnl(amm.address, alice.address, PnlCalcOption.SPOT_PRICE)).eq(0);
      });

      it("open long position, price up, then long again", async () => {
        // alice opens long position with 25 margin, 10x leverage
        // (1000 + 250) * (100 + baseAssetDelta) = 100k, baseAssetDelta = -20
        await clearingHouse
          .connect(alice)
          .openPosition(amm.address, Side.BUY, toFullDigitBN(250), toFullDigitBN(10), toFullDigitBN(20), true);
        const aliceBalance1 = await quoteToken.balanceOf(alice.address);

        // bob opens long position with 35 margin, 10x leverage, price up
        // (1250 + 350) * (80 + baseAssetDelta) = 100k, baseAssetDelta = -17.5
        await clearingHouse
          .connect(bob)
          .openPosition(amm.address, Side.BUY, toFullDigitBN(350), toFullDigitBN(10), toFullDigitBN(17.5), true);

        // alice's 20 long position worth 387.88 now
        // (1600 + quoteAssetDelta) * (62.5 + 20) = 100k, quoteAssetDelta = -387.878787878787878787
        // unrealizedPnl = positionNotional - cost = 387.878787878787878787 - 250 = 137.878787878787878787
        expect(await clearingHouseViewer.getUnrealizedPnl(amm.address, alice.address, PnlCalcOption.SPOT_PRICE)).eq(
          "137878787878787878787"
        );

        // alice opens long position with 200 margin, 2x leverage
        // (1600 + 400) * (62.5 + baseAssetDelta) = 100k, baseAssetDelta = 12.5
        const receipt = await clearingHouse
          .connect(alice)
          .openPosition(amm.address, Side.BUY, toFullDigitBN(400), toFullDigitBN(2), toFullDigitBN(12.5), true);
        const aliceBalance2 = await quoteToken.balanceOf(alice.address);

        // transferred margin = margin + fee = 200 + (200 * 2 * 10%) = 240
        expect(aliceBalance2.sub(aliceBalance1)).eq(toFullDigitBN(-240, +(await quoteToken.decimals())));

        const position = await clearingHouse.getPosition(amm.address, alice.address);
        // total position size = 20 + 12.5 = 32.5
        expect(position.size).to.eq(toFullDigitBN(32.5));
        // open notional = 250 + 400 = 650
        expect(position.openNotional).to.eq(toFullDigitBN(650));
        // total position margin = 25 + 200 = 225
        expect(position.margin).to.eq(toFullDigitBN(225));
      });

      it("open long position, price down, then long again", async () => {
        // alice opens long position with 125 margin, 2x leverage
        // (1000 + 250) * (100 + baseAssetDelta) = 100k, baseAssetDelta = -20
        await clearingHouse
          .connect(alice)
          .openPosition(amm.address, Side.BUY, toFullDigitBN(250), toFullDigitBN(2), toFullDigitBN(20), true);
        const aliceBalance1 = await quoteToken.balanceOf(alice.address);

        // bob opens short position with 125 margin, 2x leverage, price down
        // (1250 - 250) * (80 + baseAssetDelta) = 100k, baseAssetDelta = 20
        await clearingHouse
          .connect(bob)
          .openPosition(amm.address, Side.SELL, toFullDigitBN(250), toFullDigitBN(2), toFullDigitBN(20), true);

        // alice's 20 long position worth 166.67 now
        // (1000 + quoteAssetDelta) * (100 + 20) = 100k, quoteAssetDelta = -166.666666666666666666
        // unrealizedPnl = positionValue - cost = 166.666666666666666666 - 250 = -83.333333333333333333
        expect(await clearingHouseViewer.getUnrealizedPnl(amm.address, alice.address, PnlCalcOption.SPOT_PRICE)).eq(
          "-83333333333333333334"
        );

        // alice opens long position with 50 margin, 5x leverage
        // (1000 + 250) * (100 + baseAssetDelta) = 100k, baseAssetDelta = -20
        const receipt = await clearingHouse
          .connect(alice)
          .openPosition(amm.address, Side.BUY, toFullDigitBN(250), toFullDigitBN(5), toFullDigitBN(20), true);
        const aliceBalance2 = await quoteToken.balanceOf(alice.address);

        // transferred margin = margin + fee = 50 + (50 * 5 * 10%) = 75
        expect(aliceBalance2.sub(aliceBalance1)).eq(toFullDigitBN(-75, +(await quoteToken.decimals())));

        const position = await clearingHouse.getPosition(amm.address, alice.address);
        // total position size = 20 + 20 = 40
        expect(position.size).to.eq(toFullDigitBN(40));
        // open notional = 250 + 250 = 500
        expect(position.openNotional).to.eq(toFullDigitBN(500));
        // total position margin = 125 + 50 = 175
        expect(position.margin).to.eq(toFullDigitBN(175));
      });

      it("open short, price remains, then short again", async () => {
        // alice opens short position with 100 margin, 2x leverage
        // (1000 - 200) * (100 + baseAssetDelta) = 100k, baseAssetDelta = 25
        await clearingHouse
          .connect(alice)
          .openPosition(amm.address, Side.SELL, toFullDigitBN(200), toFullDigitBN(2), toFullDigitBN(25), true);
        const aliceBalance1 = await quoteToken.balanceOf(alice.address);

        // alice opens short position with 50 margin, 8x leverage
        // (800 - 400) * (125 + baseAssetDelta) = 100k, baseAssetDelta = 125
        const receipt = await clearingHouse
          .connect(alice)
          .openPosition(amm.address, Side.SELL, toFullDigitBN(400), toFullDigitBN(8), toFullDigitBN(125), true);
        const aliceBalance2 = await quoteToken.balanceOf(alice.address);

        // then transferred margin = margin + fee = 50 + (50 * 8 * 10%) = 90
        expect(aliceBalance2.sub(aliceBalance1)).eq(toFullDigitBN(-90, +(await quoteToken.decimals())));

        const position = await clearingHouse.getPosition(amm.address, alice.address);
        // total position size = -25 + -125 = -150
        expect(position.size).to.eq(toFullDigitBN(-150));
        // open notional = 200 + 400 = 600
        expect(position.openNotional).to.eq(toFullDigitBN(600));
        // total position margin = 100 + 50 = 150
        expect(position.margin).to.eq(toFullDigitBN(150));
        // pnl = 0 because no other trader
        expect(await clearingHouseViewer.getUnrealizedPnl(amm.address, alice.address, PnlCalcOption.SPOT_PRICE)).eq(0);
      });

      it("open short, price down, then short again", async () => {
        // alice opens short position with 100 margin, 2x leverage
        // (1000 - 200) * (100 + baseAssetDelta) = 100k, baseAssetDelta = 25
        await clearingHouse
          .connect(alice)
          .openPosition(amm.address, Side.SELL, toFullDigitBN(200), toFullDigitBN(2), toFullDigitBN(25), true);
        const aliceBalance1 = await quoteToken.balanceOf(alice.address);

        // bob opens short position with 150 margin, 2x leverage, price down
        // (800 - 300) * (125 + baseAssetDelta) = 100k, baseAssetDelta = 75
        await clearingHouse
          .connect(bob)
          .openPosition(amm.address, Side.SELL, toFullDigitBN(300), toFullDigitBN(2), toFullDigitBN(75), true);

        // alice's 25 short position worth 71.43 now
        // (500 + quoteAssetDelta) * (200 - 25) = 100k, quoteAssetDelta = -71.4285714286
        // unrealizedPnl = positionValueWhenBorrowed - positionValueWhenReturned = 200 - 71.4285714286 = 128.5714285714
        expect(await clearingHouseViewer.getUnrealizedPnl(amm.address, alice.address, PnlCalcOption.SPOT_PRICE)).eq(
          "128571428571428571428"
        );

        // alice opens short position with 100 margin, 3x leverage
        // (500 - 300) * (200 + baseAssetDelta) = 100k, baseAssetDelta = 300
        const receipt = await clearingHouse
          .connect(alice)
          .openPosition(amm.address, Side.SELL, toFullDigitBN(300), toFullDigitBN(3), toFullDigitBN(300), true);
        const aliceBalance2 = await quoteToken.balanceOf(alice.address);

        // transferred margin = margin + fee = 100 + (100 * 3 * 10%) = 130
        expect(aliceBalance2.sub(aliceBalance1)).eq(toFullDigitBN(-130, +(await quoteToken.decimals())));

        const position = await clearingHouse.getPosition(amm.address, alice.address);
        // total position size = -25 - 300 = -325
        expect(position.size).to.eq(toFullDigitBN(-325));
        // open notional = 200 + 300 = 500
        expect(position.openNotional).to.eq(toFullDigitBN(500));
        // total position margin = 100 + 100 = 200
        expect(position.margin).to.eq(toFullDigitBN(200));
      });

      it("open short, price up, then short again", async () => {
        // alice opens short position with 200 margin, 1x leverage
        // (1000 - 200) * (100 + baseAssetDelta) = 100k, baseAssetDelta = 25
        await clearingHouse
          .connect(alice)
          .openPosition(amm.address, Side.SELL, toFullDigitBN(200), toFullDigitBN(1), toFullDigitBN(25), true);
        const aliceBalance1 = await quoteToken.balanceOf(alice.address);

        // bob opens long position with 200 margin, 1x leverage, price up
        // (800 + 200) * (125 + baseAssetDelta) = 100k, baseAssetDelta = -25
        await clearingHouse.connect(bob).openPosition(amm.address, Side.BUY, toFullDigitBN(200), toFullDigitBN(1), toFullDigitBN(25), true);

        // alice's 25 short position worth 333.33 now
        // (1000 + quoteAssetDelta) * (100 - 25) = 100k, quoteAssetDelta = 333.3333333333
        // unrealizedPnl = positionValueWhenBorrowed - positionValueWhenReturned = 200 - 333.3333333333 = -133.3333333333
        expect(await clearingHouseViewer.getUnrealizedPnl(amm.address, alice.address, PnlCalcOption.SPOT_PRICE)).eq(
          "-133333333333333333334"
        );

        // alice opens short position with 50 margin, 4x leverage
        // (1000 - 200) * (100 + baseAssetDelta) = 100k, baseAssetDelta = 25
        await clearingHouse
          .connect(alice)
          .openPosition(amm.address, Side.SELL, toFullDigitBN(200), toFullDigitBN(4), toFullDigitBN(25), true);
        const aliceBalance2 = await quoteToken.balanceOf(alice.address);

        // then transferred margin = margin + fee = 50 + (50 * 4 * 10%) = 70
        expect(aliceBalance2.sub(aliceBalance1)).eq(toFullDigitBN(-70, +(await quoteToken.decimals())));

        const position = await clearingHouse.getPosition(amm.address, alice.address);
        // total position size = -25 - 25 = -50
        expect(position.size).to.eq(toFullDigitBN(-50));
        // open notional = 200 + 200 = 400
        expect(position.openNotional).to.eq(toFullDigitBN(400));
        // total position margin = oldMargin + newMargin + realizedPnl = 200 + 50 + 0 = 250
        expect(position.margin).to.eq(toFullDigitBN(250));
      });
    });

    describe("reduce position", () => {
      it("open long position, price remains, then reduce position", async () => {
        // alice opens long position with 60 margin, 10x leverage
        // (1000 + 600) * (100 + baseAssetDelta) = 100k, baseAssetDelta = -37.5
        await clearingHouse
          .connect(alice)
          .openPosition(amm.address, Side.BUY, toFullDigitBN(600), toFullDigitBN(10), toFullDigitBN(37.5), true);

        // alice reduce position in 350 quoteAsset amount
        // (1600 - 350) * (62.5 + baseAssetDelta) = 100k, baseAssetDelta = 17.5
        await clearingHouse
          .connect(alice)
          .openPosition(amm.address, Side.SELL, toFullDigitBN(350), toFullDigitBN(1), toFullDigitBN(17.5), true);

        const position = await clearingHouse.getPosition(amm.address, alice.address);
        // total position size = 37.5 - 17.5 = 20
        expect(position.size).to.eq(toFullDigitBN(20));
        // openNotional = originalPositionNotional - reducedPositionNotional = 600 - 350 = 250
        expect(position.openNotional).to.eq(toFullDigitBN(250));
        // total position margin = margin + realizedPnl = 60
        expect(position.margin).to.eq(toFullDigitBN(60));
        // pnl is 0 because no other traders
        expect(await clearingHouseViewer.getUnrealizedPnl(amm.address, alice.address, PnlCalcOption.SPOT_PRICE)).eq(0);
      });

      it("open long position, price remains, then reduce position - 0% fee", async () => {
        // given the fee is set to zero
        await amm.setTollRatio(toFullDigitBN(0));
        await amm.setSpreadRatio(toFullDigitBN(0));

        // alice opens long position with 60 margin, 10x leverage
        // (1000 + 600) * (100 + baseAssetDelta) = 100k, baseAssetDelta = -37.5
        await clearingHouse
          .connect(alice)
          .openPosition(amm.address, Side.BUY, toFullDigitBN(600), toFullDigitBN(10), toFullDigitBN(37.5), true);

        // alice reduce position in 350 quoteAsset amount
        // (1600 - 350) * (62.5 + baseAssetDelta) = 100k, baseAssetDelta = 17.5
        await clearingHouse
          .connect(alice)
          .openPosition(amm.address, Side.SELL, toFullDigitBN(350), toFullDigitBN(1), toFullDigitBN(17.5), true);
        const position = await clearingHouse.getPosition(amm.address, alice.address);
        // total position size = 37.5 - 17.5 = 20
        expect(position.size).to.eq(toFullDigitBN(20));
        // openNotional = positionNotional - unrealizedPnl = 250 - 0 = 250
        expect(position.openNotional).to.eq(toFullDigitBN(250));
        // total position margin = 60 - 0 = 60
        expect(position.margin).to.eq(toFullDigitBN(60));
        // pnl is 0 because no other traders
        expect(await clearingHouseViewer.getUnrealizedPnl(amm.address, alice.address, PnlCalcOption.SPOT_PRICE)).eq(0);
      });

      it("open short position, price remains, then reduce position", async () => {
        // alice opens short position with 60 margin, 10x leverage
        // (1000 - 600) * (100 + baseAssetDelta) = 100k, baseAssetDelta = 150
        await clearingHouse
          .connect(alice)
          .openPosition(amm.address, Side.SELL, toFullDigitBN(600), toFullDigitBN(10), toFullDigitBN(150), true);

        // alice reduce position in 400 quoteAsset amount
        // (400 + 400) * (250 + baseAssetDelta) = 100k, baseAssetDelta = -125
        await clearingHouse
          .connect(alice)
          .openPosition(amm.address, Side.BUY, toFullDigitBN(400), toFullDigitBN(1), toFullDigitBN(125), true);

        const position = await clearingHouse.getPosition(amm.address, alice.address);
        // total position size = -150 + 125 = -25
        expect(position.size).to.eq(toFullDigitBN(-25));
        // openNotional = positionNotional(200) - unrealizedPnl(0) = 200
        expect(position.openNotional).to.eq(toFullDigitBN(200));
        // total position margin = margin + realizedPnl = 60 + 0 = 60
        expect(position.margin).to.eq(toFullDigitBN(60));
        // pnl is 0 because no other traders
        expect(await clearingHouseViewer.getUnrealizedPnl(amm.address, alice.address, PnlCalcOption.SPOT_PRICE)).eq(0);
      });

      it("open long position, price up, then reduce position", async () => {
        // alice opens long position with 60 margin, 10x leverage
        // (1000 + 600) * (100 + baseAssetDelta) = 100k, baseAssetDelta = -37.5
        await clearingHouse
          .connect(alice)
          .openPosition(amm.address, Side.BUY, toFullDigitBN(600), toFullDigitBN(10), toFullDigitBN(37.5), true);

        // bob opens long position with 400 margin, 1x leverage. price up.
        // (1600 + 400) * (62.5 + baseAssetDelta) = 100k, baseAssetDelta = 12.5
        await clearingHouse
          .connect(bob)
          .openPosition(amm.address, Side.BUY, toFullDigitBN(400), toFullDigitBN(1), toFullDigitBN(12.5), true);

        // alice's 37.5 long position worth 857.14 now
        // (2000 + quoteAssetDelta) * (50 + 37.5) = 100k, quoteAssetDelta = -857.1428571429
        // unrealizedPnl = positionNotional - openNotional = 857.1428571429 - 600 = 257.1428571429
        expect(await clearingHouseViewer.getUnrealizedPnl(amm.address, alice.address, PnlCalcOption.SPOT_PRICE)).eq(
          "257142857142857142857"
        );

        // alice reduce position in 400 quoteAsset amount
        // (2000 - 400) * (50 + baseAssetDelta) = 100k, baseAssetDelta = 12.5
        await clearingHouse
          .connect(alice)
          .openPosition(amm.address, Side.SELL, toFullDigitBN(400), toFullDigitBN(1), toFullDigitBN(12.5), true);

        const position = await clearingHouse.getPosition(amm.address, alice.address);
        // total position size = 37.5 - 12.5 = 25
        expect(position.size).to.eq(toFullDigitBN(25));
        // remain unrealizedPnl = unrealizedPnl - realizedPnl = 257.1428571429 - 85.7142857143 = 171.4285714286
        expect(await clearingHouseViewer.getUnrealizedPnl(amm.address, alice.address, PnlCalcOption.SPOT_PRICE)).eq(
          "171428571428571428572"
        );
        // alice's 25 long position worth 457.14 now
        // (1600 + quoteAssetDelta) * (62.5 + 25) = 100k, quoteAssetDelta = -457.1428571429
        // openNotional = positionNotional - unrealizedPnl = 457.1428571429 - 171.4285714286 = 285.7142857143
        expect(position.openNotional).to.eq("285714285714285714285");
        // total position margin = 60 + realizedPnl = 60 + 85.61 = 145.61
        expect(position.margin).to.eq("145714285714285714285");
      });

      it("open long position, price down, then reduce position", async () => {
        // alice opens long position with 500 margin, 2x leverage
        // (1000 + 1000) * (100 + baseAssetDelta) = 100k, baseAssetDelta = -50
        await clearingHouse
          .connect(alice)
          .openPosition(amm.address, Side.BUY, toFullDigitBN(1000), toFullDigitBN(2), toFullDigitBN(50), true);

        // bob opens short position with 400 margin, 1x leverage. price down
        // (2000 - 400) * (50 + baseAssetDelta) = 100k, baseAssetDelta = 12.5
        await clearingHouse
          .connect(bob)
          .openPosition(amm.address, Side.SELL, toFullDigitBN(400), toFullDigitBN(1), toFullDigitBN(12.5), true);

        // alice's 50 long position worth 711.11 now
        // (1600 + quoteAssetDelta) * (62.5 + 50) = 100k, quoteAssetDelta = -711.1111111111
        // unrealizedPnl = positionNotional - openNotional = 711.1111111111 - 1000 = -288.8888888888
        expect(await clearingHouseViewer.getUnrealizedPnl(amm.address, alice.address, PnlCalcOption.SPOT_PRICE)).eq(
          "-288888888888888888889"
        );

        // alice reduce position in 350 quoteAsset amount
        // (1600 - 350) * (62.5 + baseAssetDelta) = 100k, baseAssetDelta = 17.5
        await clearingHouse
          .connect(alice)
          .openPosition(amm.address, Side.SELL, toFullDigitBN(350), toFullDigitBN(1), toFullDigitBN(17.5), true);

        const position = await clearingHouse.getPosition(amm.address, alice.address);
        // total position size = 50 - 17.5 = 32.5
        expect(position.size).to.eq(toFullDigitBN(32.5));
        // remain unrealizedPnl = unrealizedPnl - realizedPnl = -288.8888888888 + 101.1111111111 = -187.7777777777
        expect(await clearingHouseViewer.getUnrealizedPnl(amm.address, alice.address, PnlCalcOption.SPOT_PRICE)).eq(
          "-187777777777777777778"
        );
        // alice's 32.5 long position worth 361.11 now
        // (1250 + quoteAssetDelta) * (80 + 32.5) = 100k, quoteAssetDelta = -361.1111111111
        // remainOpenNotional = remainPositionNotional - remainUnrealizedPnl = 361.1111111111 - (-187.7777777777) = 548.8888888888
        expect(position.openNotional).to.eq("548888888888888888889");
        // total position margin = oldMargin + realizedPnl = 500 - 101.1111111111 = 398.888888889
        expect(position.margin).to.eq("398888888888888888889");
      });

      it("open short position, price up, then reduce position", async () => {
        // alice opens short position with 100 margin, 2x leverage
        // (1000 - 200) * (100 + baseAssetDelta) = 100k, baseAssetDelta = 25
        await clearingHouse
          .connect(alice)
          .openPosition(amm.address, Side.SELL, toFullDigitBN(200), toFullDigitBN(2), toFullDigitBN(25), true);

        // bob opens long position with 50 margin, 1x leverage. price up
        // (800 + 50) * (125 + baseAssetDelta) = 100k, baseAssetDelta = -7.3529411765
        await clearingHouse
          .connect(bob)
          .openPosition(amm.address, Side.BUY, toFullDigitBN(50), toFullDigitBN(1), toFullDigitBN(7.35), true);

        // alice's 25 short position worth 229.37 now
        // (850 + quoteAssetDelta) * (117.6470588235 - 25) = 100k, quoteAssetDelta = 229.3650793654
        // unrealizedPnl = positionValueWhenBorrowed - positionValueWhenReturned = 200 - 229.3650793654 = -29.3650793654
        expect(await clearingHouseViewer.getUnrealizedPnl(amm.address, alice.address, PnlCalcOption.SPOT_PRICE)).eq(
          "-29365079365079365079"
        );

        // alice reduce position in 150 quoteAsset amount
        // (850 + 150) * (117.6470588235 + baseAssetDelta) = 100k, baseAssetDelta = -17.6470588235
        await clearingHouse
          .connect(alice)
          .openPosition(amm.address, Side.BUY, toFullDigitBN(150), toFullDigitBN(1), toFullDigitBN(17.64), true);

        const position = await clearingHouse.getPosition(amm.address, alice.address);

        // total position size = -25 + 17.6470588235 = -7.3529411765
        expect(position.size).to.eq("-7352941176470588236");
        // remain unrealizedPnl = unrealizedPnl - realizedPnl = -29.3650793654 + 20.7282913155 = -8.6367880499
        expect(await clearingHouseViewer.getUnrealizedPnl(amm.address, alice.address, PnlCalcOption.SPOT_PRICE)).eq("-8636788048552754444");
        // alice's 7.3529411765 short position worth 79.37 now
        // (1000 + quoteAssetDelta) * (100 + 7.3529411765) = 100k, quoteAssetDelta = -79.37
        // openNotional = positionNotional + unrealizedPnl = 79.37 + (-8.6367880499) = 70.7332119501
        expect(position.openNotional).to.eq("70728291316526610643");
        // total position margin = margin + realizedPnl = 100 - 20.7282913155 = 79.2717086845
        expect(position.margin).to.eq("79271708683473389357");
      });

      it("open short position, price down, then reduce position", async () => {
        // alice opens short position with 250 margin, 2x leverage
        // (1000 - 500) * (100 + baseAssetDelta) = 100k, baseAssetDelta = 100
        await clearingHouse
          .connect(alice)
          .openPosition(amm.address, Side.SELL, toFullDigitBN(500), toFullDigitBN(2), toFullDigitBN(100), true);

        // bob opens short position with 100 margin, 1x leverage. price down
        // (500 - 100) * (200 + baseAssetDelta) = 100k, baseAssetDelta = 50
        await clearingHouse
          .connect(bob)
          .openPosition(amm.address, Side.SELL, toFullDigitBN(100), toFullDigitBN(1), toFullDigitBN(50), true);

        // alice's 100 short position worth 266.67 now
        // (400 + quoteAssetDelta) * (250 - 100) = 100k, quoteAssetDelta = 266.6666666666
        // unrealizedPnl = positionValueWhenBorrowed - positionValueWhenReturned = 500 - 266.6666666666 = 233.3333333333
        expect(await clearingHouseViewer.getUnrealizedPnl(amm.address, alice.address, PnlCalcOption.SPOT_PRICE)).eq(
          "233333333333333333333"
        );

        // alice reduce position in 100 quoteAsset amount
        // (400 + 100) * (250 + baseAssetDelta) = 100k, baseAssetDelta = -50
        await clearingHouse
          .connect(alice)
          .openPosition(amm.address, Side.BUY, toFullDigitBN(100), toFullDigitBN(1), toFullDigitBN(50), true);

        const position = await clearingHouse.getPosition(amm.address, alice.address);
        // total position size = -100 + 50 = -50
        expect(position.size).to.eq(toFullDigitBN(-50));
        // remain unrealizedPnl = unrealizedPnl - realizedPnl = 233.3333333333 - 116.6666666666 = 116.6666666666
        expect(await clearingHouseViewer.getUnrealizedPnl(amm.address, alice.address, PnlCalcOption.SPOT_PRICE)).eq(
          "116666666666666666667"
        );
        // alice's 50 short position worth 166.67 now
        // (500 + quoteAssetDelta) * (200 - 50) = 100k, quoteAssetDelta = 166.6666666666
        // openNotional = positionNotional + unrealizedPnl = 166.6666666666 + 116.6666666666 = 283.3333333332
        expect(position.openNotional).to.eq("283333333333333333334");
        // total position margin = margin + realizedPnl = 250 + 116.6666666666 = 366.6666666666
        expect(position.margin).to.eq("366666666666666666666");
      });
    });

    describe("manually close position", () => {
      it("open long position, price remains, then close entire position manually", async () => {
        // alice opens long position with 50 margin, 5x leverage
        // (1000 + 250) * (100 + baseAssetDelta) = 100k, baseAssetDelta = -20
        await clearingHouse
          .connect(alice)
          .openPosition(amm.address, Side.BUY, toFullDigitBN(250), toFullDigitBN(5), toFullDigitBN(20), true);
        const aliceBalance1 = await quoteToken.balanceOf(alice.address);

        // alice opens short position with 250 margin, 1x leverage. (close position manually)
        const receipt = await clearingHouse
          .connect(alice)
          .openPosition(amm.address, Side.SELL, toFullDigitBN(250), toFullDigitBN(1), toFullDigitBN(20), true);
        const aliceBalance2 = await quoteToken.balanceOf(alice.address);

        // closeRatio = closePositionSize/positionSize = 100%
        // realizedPnl = unrealizedPnl * closeRatio = 0 * 100% = 0
        // closeMargin = currentMargin * closeRatio = 50 * 100% = 50
        // fee = 250 * 1 * 10% = 25
        // transferred margin = closedMargin + realizedPnl = 50 + 0 = 50

        await expect(receipt)
          .to.emit(quoteToken, "Transfer")
          .withArgs(clearingHouse.address, alice.address, toFullDigitBN(50, +(await quoteToken.decimals())));

        // transferred margin = closedMargin - fee + realizedPnl = 50 - 25 + 0 = 25
        expect(aliceBalance2.sub(aliceBalance1)).eq(toFullDigitBN(25, +(await quoteToken.decimals())));

        const position = await clearingHouse.getPosition(amm.address, alice.address);
        expect(position.size).to.eq(toFullDigitBN(0));
        expect(position.openNotional).to.eq(toFullDigitBN(0));
        expect(position.margin).to.eq(toFullDigitBN(0));
      });

      it("open short position, price remains, then closing entire position manually", async () => {
        // alice opens short position with 100 margin, 2x leverage
        // (1000 - 200) * (100 + baseAssetDelta) = 100k, baseAssetDelta = 25
        await clearingHouse
          .connect(alice)
          .openPosition(amm.address, Side.SELL, toFullDigitBN(200), toFullDigitBN(2), toFullDigitBN(25), true);
        const aliceBalance1 = await quoteToken.balanceOf(alice.address);

        // alice opens long position with 200 margin, 1x leverage. (close position manually)
        const receipt = await clearingHouse
          .connect(alice)
          .openPosition(amm.address, Side.BUY, toFullDigitBN(200), toFullDigitBN(1), toFullDigitBN(25), true);
        const aliceBalance2 = await quoteToken.balanceOf(alice.address);

        // closeRatio = closePositionSize/positionSize = 100%
        // realizedPnl = unrealizedPnl * closeRatio = 0 * 100% = 0
        // closeMargin = currentMargin * closeRatio = 100 * 100% = 100
        // transferred margin = closedMargin + realizedPnl = 100 + 0 = 100

        await expect(receipt)
          .to.emit(quoteToken, "Transfer")
          .withArgs(clearingHouse.address, alice.address, toFullDigitBN(100, +(await quoteToken.decimals())));

        // fee = 200 * 1 * 10% = 20
        // TODO expect fee event
        // 100 - 20 = 80
        expect(aliceBalance2.sub(aliceBalance1)).eq(toFullDigitBN(80, +(await quoteToken.decimals())));

        const position = await clearingHouse.getPosition(amm.address, alice.address);
        expect(position.size).to.eq(toFullDigitBN(0));
        expect(position.openNotional).to.eq(toFullDigitBN(0));
        expect(position.margin).to.eq(toFullDigitBN(0));
      });

      it("open long position, price up, then close entire position manually", async () => {
        // given some other traders open some amount of position
        // to prevent vault doesnt have enough collateral to pay profit in this test case
        await transfer(admin, clearingHouse.address, 1000);

        // alice opens long position with 25 margin, 10x leverage
        // (1000 + 250) * (100 + baseAssetDelta) = 100k, baseAssetDelta = -20
        await clearingHouse
          .connect(alice)
          .openPosition(amm.address, Side.BUY, toFullDigitBN(250), toFullDigitBN(10), toFullDigitBN(20), true);
        const aliceBalance1 = await quoteToken.balanceOf(alice.address);

        // bob opens long position with 35 margin, 10x leverage, price up
        // (1250 + 350) * (80 + baseAssetDelta) = 100k, baseAssetDelta = -17.5
        await clearingHouse
          .connect(bob)
          .openPosition(amm.address, Side.BUY, toFullDigitBN(350), toFullDigitBN(10), toFullDigitBN(17.5), true);

        // alice's 20 long position worth 387.88 now
        // (1600 + quoteAssetDelta) * (62.5 + 20) = 100k, quoteAssetDelta = -387.8787878787
        // unrealizedPnl = positionNotional - cost = 387.8787878787 - 250 = 137.8787878787
        const currentPositionValue = await clearingHouse.getPositionNotionalAndUnrealizedPnl(
          amm.address,
          alice.address,
          PnlCalcOption.SPOT_PRICE
        );

        expect(currentPositionValue[1]).eq("137878787878787878787");

        // alice opens short position with 387.88 margin, 1x leverage. (close position manually)
        const receipt = await clearingHouse
          .connect(alice)
          .openPosition(amm.address, Side.SELL, currentPositionValue[0], toFullDigitBN(1), toFullDigitBN(20), true);
        const aliceBalance2 = await quoteToken.balanceOf(alice.address);

        // closeRatio = closePositionSize/positionSize = 100%
        // realizedPnl = unrealizedPnl * closeRatio = 137.8787878787 * 100% = 137.8787878787
        // closeMargin = currentMargin * closeRatio = 25 * 100% = 50
        // transferred margin = closedMargin + realizedPnl = 25 + 137.8787878787 = 162.8787878787
        // fee = 387.8787878787 * 10% = 38.7878787878
        // 162.8787878787 - 38.7878 = 124.0909878787
        expect(aliceBalance2.sub(aliceBalance1)).eq("124090909090909090909");

        const position = await clearingHouse.getPosition(amm.address, alice.address);
        expect(position.size).to.eq(toFullDigitBN(0));
        expect(position.openNotional).to.eq(toFullDigitBN(0));
        expect(position.margin).to.eq(toFullDigitBN(0));
      });

      it("open long position, price down, then close entire position manually", async () => {
        // alice opens long position with 500 margin, 2x leverage
        // (1000 + 1000) * (100 + baseAssetDelta) = 100k, baseAssetDelta = -50
        await clearingHouse
          .connect(alice)
          .openPosition(amm.address, Side.BUY, toFullDigitBN(1000), toFullDigitBN(2), toFullDigitBN(50), true);
        const aliceBalance1 = await quoteToken.balanceOf(alice.address);

        // bob opens short position with 400 margin, 1x leverage. price down
        // (2000 - 400) * (50 + baseAssetDelta) = 100k, baseAssetDelta = 12.5
        await clearingHouse
          .connect(bob)
          .openPosition(amm.address, Side.SELL, toFullDigitBN(400), toFullDigitBN(1), toFullDigitBN(12.5), true);

        // alice's 50 long position worth 711.11 now
        // (1600 + quoteAssetDelta) * (62.5 + 50) = 100k, quoteAssetDelta = -711.111111111111111111
        // unrealizedPnl = positionNotional - openNotional = 711.111111111111111111 - 1000 = -288.888888888888888888
        const currentPositionValue = await clearingHouse.getPositionNotionalAndUnrealizedPnl(
          amm.address,
          alice.address,
          PnlCalcOption.SPOT_PRICE
        );
        expect(currentPositionValue[1]).eq("-288888888888888888889");

        // alice opens short position with 711.11 margin, 1x leverage. (close position manually)
        const receipt = await clearingHouse
          .connect(alice)
          .openPosition(amm.address, Side.SELL, currentPositionValue[0], toFullDigitBN(1), toFullDigitBN(50), true);
        const aliceBalance2 = await quoteToken.balanceOf(alice.address);

        // closeRatio = closePositionSize/positionSize = 100%
        // realizedPnl = unrealizedPnl * closeRatio = -288.888888888888888888 * 100% = -288.888888888888888888
        // closeMargin = currentMargin * closeRatio = 500 * 100% = 500
        // fee = 711.111111111111111111 * 10% = 71.1111111111111111111
        // transferred margin = closedMargin - fee + realizedPnl = 500 - 71.1111111111111111111 - 288.888888888888888888 = 140
        expect(aliceBalance2.sub(aliceBalance1)).eq(toFullDigitBN(140, +(await quoteToken.decimals())));

        const position = await clearingHouse.getPosition(amm.address, alice.address);
        expect(position.size).to.eq(toFullDigitBN(0));
        expect(position.openNotional).to.eq(toFullDigitBN(0));
        expect(position.margin).to.eq(toFullDigitBN(0));
      });

      it("open short position, price up, then close entire position manually", async () => {
        // alice opens short position with 200 margin, 1x leverage
        // (1000 - 200) * (100 + baseAssetDelta) = 100k, baseAssetDelta = 25
        await clearingHouse
          .connect(alice)
          .openPosition(amm.address, Side.SELL, toFullDigitBN(200), toFullDigitBN(1), toFullDigitBN(25), true);
        const aliceBalance1 = await quoteToken.balanceOf(alice.address);

        // bob opens long position with 50 margin, 1x leverage. price up
        // (800 + 50) * (125 + baseAssetDelta) = 100k, baseAssetDelta = -7.3529411765
        await clearingHouse
          .connect(bob)
          .openPosition(amm.address, Side.BUY, toFullDigitBN(50), toFullDigitBN(1), toFullDigitBN(7.35), true);

        // alice's 25 short position worth 229.37 now
        // (850 + quoteAssetDelta) * (117.6470588235 - 25) = 100k, quoteAssetDelta = 229.3650793654
        // unrealizedPnl = positionValueWhenBorrowed - positionValueWhenReturned = 200 - 229.3650793654 = -29.3650793654
        const currentPositionValue = await clearingHouse.getPositionNotionalAndUnrealizedPnl(
          amm.address,
          alice.address,
          PnlCalcOption.SPOT_PRICE
        );
        expect(currentPositionValue[1]).eq("-29365079365079365079");

        // alice opens long position with 29.3650793654 margin, 1x leverage. (close position manually)
        const receipt = await clearingHouse
          .connect(alice)
          .openPosition(amm.address, Side.BUY, currentPositionValue[0], toFullDigitBN(1), toFullDigitBN(25), true);
        const aliceBalance2 = await quoteToken.balanceOf(alice.address);

        // closeRatio = closePositionSize/positionSize = 100%
        // realizedPnl = unrealizedPnl * closeRatio = -29.3650793654 * 100% = -29.3650793654
        // closeMargin = currentMargin * closeRatio = 200 * 100% = 200
        // fee = 229.3650793654 * 1 * 10% = 22.9365079365
        // marginToTrader = closedMargin - fee + realizedPnl = 200 - 22.9365079365 - 29.3650793654 = 147.6984126981
        expect(aliceBalance2.sub(aliceBalance1)).eq("147698412698412698414");

        const position = await clearingHouse.getPosition(amm.address, alice.address);
        expect(position.size).to.eq(toFullDigitBN(0));
        expect(position.openNotional).to.eq(toFullDigitBN(0));
        expect(position.margin).to.eq(toFullDigitBN(0));
      });

      it("open short position, price down, then close entire position manually", async () => {
        // given some other traders open some amount of position
        // to prevent vault doesn't have enough collateral to pay profit in this test case
        await transfer(admin, clearingHouse.address, 1000);

        // alice opens short position with 250 margin, 2x leverage
        // (1000 - 500) * (100 + baseAssetDelta) = 100k, baseAssetDelta = 100
        await clearingHouse
          .connect(alice)
          .openPosition(amm.address, Side.SELL, toFullDigitBN(500), toFullDigitBN(2), toFullDigitBN(100), true);
        const aliceBalance1 = await quoteToken.balanceOf(alice.address);

        // bob opens short position with 100 margin, 1x leverage. price down
        // (500 - 100) * (200 + baseAssetDelta) = 100k, baseAssetDelta = 50
        await clearingHouse
          .connect(bob)
          .openPosition(amm.address, Side.SELL, toFullDigitBN(100), toFullDigitBN(1), toFullDigitBN(50), true);

        // alice's 100 short position worth 266.67 now
        // (400 + quoteAssetDelta) * (250 - 100) = 100k, quoteAssetDelta = 266.666666666666666666
        // unrealizedPnl = positionValueWhenBorrowed - positionValueWhenReturned = 500 - 266.666666666666666666 = 233.333333333333333333
        const currentPositionValue = await clearingHouse.getPositionNotionalAndUnrealizedPnl(
          amm.address,
          alice.address,
          PnlCalcOption.SPOT_PRICE
        );
        expect(currentPositionValue[1]).eq("233333333333333333333");

        // alice opens long position with 266.666666666666666666 margin, 1x leverage. (close position manually)
        const receipt = await clearingHouse
          .connect(alice)
          .openPosition(amm.address, Side.BUY, currentPositionValue[0], toFullDigitBN(1), toFullDigitBN(100), true);
        const aliceBalance2 = await quoteToken.balanceOf(alice.address);

        // closeRatio = closePositionSize/positionSize = 100%
        // realizedPnl = unrealizedPnl * closeRatio = 233.333333333333333333 * 100% = 233.333333333333333333
        // closeMargin = currentMargin * closeRatio = 250 * 100% = 250
        // newRequireMargin = abs(newPositionNotional / newLeverage) = 0
        // fee = 266.666666666666666666 * 1 * 10% = 26.666666666666666666
        // marginToTrader = closedMargin - newRequireMargin - fee + realizedPnl = 250 - 0 - 26.66 + 233.33 = 456.67
        expect(aliceBalance2.sub(aliceBalance1)).eq("456666666666666666667");

        const position = await clearingHouse.getPosition(amm.address, alice.address);
        expect(position.size).to.eq(toFullDigitBN(0));
        expect(position.openNotional).to.eq(toFullDigitBN(0));
        expect(position.margin).to.eq(toFullDigitBN(0));
      });
    });

    describe("opens a position, then opens an larger position in reversed direction", () => {
      it("open long position, price remains, then close entire position by opening another larger short", async () => {
        // alice opens long position with 125 margin, 2x leverage
        // (1000 + 250) * (100 + baseAssetDelta) = 100k, baseAssetDelta = -20
        await clearingHouse
          .connect(alice)
          .openPosition(amm.address, Side.BUY, toFullDigitBN(250), toFullDigitBN(2), toFullDigitBN(20), true);
        const aliceBalance1 = await quoteToken.balanceOf(alice.address);

        // alice opens short position with 45 margin, 10x leverage, price down
        // (1250 - 450) * (80 + baseAssetDelta) = 100k, baseAssetDelta = 45
        const receipt = await clearingHouse
          .connect(alice)
          .openPosition(amm.address, Side.SELL, toFullDigitBN(450), toFullDigitBN(10), toFullDigitBN(45), true);
        const aliceBalance2 = await quoteToken.balanceOf(alice.address);

        // closeRatio = closePositionSize/positionSize = max(1, 45/20) = 100%
        // realizedPnl = unrealizedPnl * closeRatio = 0
        // closeMargin = currentMargin * closeRatio = 125
        // fee = 45 * 10 * 10% = 45
        // remainPositionNotional = 450 - 250 = 200
        // newRequireMargin = abs(newPositionNotional / newLeverage) = abs(200/10) = 20
        // marginToVault = newRequireMargin - closedMargin + fee - realizedPnl = 20 - 125 + 45 - 0 = -60
        expect(aliceBalance2.sub(aliceBalance1)).eq(toFullDigitBN(60, +(await quoteToken.decimals())));

        const position = await clearingHouse.getPosition(amm.address, alice.address);
        // total position size = 20 - 45 = -25
        expect(position.size).to.eq(toFullDigitBN(-25));
        // alice's 25 short position worth 200 now
        // (800 + quoteAssetDelta) * (125 - 25) = 100k, quoteAssetDelta = 200
        // openNotional = positionNotional - unrealizedPnl = 200 - 0 = 200
        expect(position.openNotional).to.eq(toFullDigitBN(200));
        // newRequireMargin
        expect(position.margin).to.eq(toFullDigitBN(20));
        expect(await clearingHouseViewer.getUnrealizedPnl(amm.address, alice.address, PnlCalcOption.SPOT_PRICE)).eq(0);
      });

      it("open short position, price remains, then close entire position by opening another larger long", async () => {
        // alice opens short position with 20 margin, 10x leverage
        // (1000 - 200) * (100 + baseAssetDelta) = 100k, baseAssetDelta = 25
        await clearingHouse
          .connect(alice)
          .openPosition(amm.address, Side.SELL, toFullDigitBN(200), toFullDigitBN(10), toFullDigitBN(25), true);
        const aliceBalance1 = await quoteToken.balanceOf(alice.address);

        // alice opens long position with 90 margin, 5 leverage, price up
        // (800 + 450) * (125 + baseAssetDelta) = 100k, baseAssetDelta = -45
        const receipt = await clearingHouse
          .connect(alice)
          .openPosition(amm.address, Side.BUY, toFullDigitBN(450), toFullDigitBN(5), toFullDigitBN(45), true);
        const aliceBalance2 = await quoteToken.balanceOf(alice.address);

        // closeRatio = closePositionSize/positionSize = max(1, 45/25) = 100%
        // realizedPnl = unrealizedPnl * closeRatio = 0
        // closeMargin = currentMargin * closeRatio = 20
        // remainPositionNotional = 450 - 200 = 250
        // newRequireMargin = remainPositionNotional / newLeverage = 250/5 = 50
        // fee = 90 * 5 * 10% = 45
        // marginToTrader = closedMargin - newRequireMargin - fee + realizedPnl = 20 - 50 - 45 + 0 = -75
        expect(aliceBalance2.sub(aliceBalance1)).eq(toFullDigitBN(-75, +(await quoteToken.decimals())));

        const position = await clearingHouse.getPosition(amm.address, alice.address);
        // total position size = -25 + 45 = 20
        expect(position.size).to.eq(toFullDigitBN(20));
        // alice's 20 long position worth 250 now
        // (1250 + quoteAssetDelta) * (80 + 20) = 100k, quoteAssetDelta = -250
        // openNotional = positionNotional - unrealizedPnl = 250 - 0 = 250
        expect(position.openNotional).to.eq(toFullDigitBN(250));
        // total position margin = 90 - 50 = 40
        expect(position.margin).to.eq(toFullDigitBN(50));
        // pnl is 0 because alice closed her entire position and opens new position in reverse dir
        expect(await clearingHouseViewer.getUnrealizedPnl(amm.address, alice.address, PnlCalcOption.SPOT_PRICE)).eq(0);
      });

      it("open long position, price up, then close entire position by opening another larger short", async () => {
        // alice opens long position with 25 margin, 10x leverage
        await clearingHouse
          .connect(alice)
          .openPosition(amm.address, Side.BUY, toFullDigitBN(250), toFullDigitBN(10), toFullDigitBN(20), true);
        // (1000 + 250) * (100 + baseAssetDelta) = 100k, baseAssetDelta = -20

        const aliceBalance1 = await quoteToken.balanceOf(alice.address);

        // bob opens long position with 35 margin, 10x leverage, price up
        // (1250 + 350) * (80 + baseAssetDelta) = 100k, baseAssetDelta = -17.5
        await clearingHouse
          .connect(bob)
          .openPosition(amm.address, Side.BUY, toFullDigitBN(350), toFullDigitBN(10), toFullDigitBN(17.5), true);

        // alice's 20 long position worth 387.88 now
        // (1600 + quoteAssetDelta) * (62.5 + 20) = 100k, quoteAssetDelta = -387.878787878787878787
        // unrealizedPnl = positionNotional - cost = 387.878787878787878787 - 250 = 137.878787878787878787
        expect(await clearingHouseViewer.getUnrealizedPnl(amm.address, alice.address, PnlCalcOption.SPOT_PRICE)).eq(
          "137878787878787878787"
        );

        // alice opens short position with 100 margin, 8x leverage
        // (1600 - 800) * (62.5 + baseAssetDelta) = 100k, baseAssetDelta = 62.5
        const receipt = await clearingHouse
          .connect(alice)
          .openPosition(amm.address, Side.SELL, toFullDigitBN(800), toFullDigitBN(8), toFullDigitBN(62.51), true);
        const aliceBalance2 = await quoteToken.balanceOf(alice.address);

        // closeRatio = closePositionSize/positionSize = max(1, 62.5/20) = 100%
        // realizedPnl = unrealizedPnl * closeRatio = 137.878787878787878787
        // closeMargin = currentMargin * closeRatio = 100
        // remainPositionNotional = 800 - 387.88 = 412.12
        // requiredNewMargin = remainPositionNotional/newLeverage = 412.12/8 = 51.515
        // fee = 100 * 8 * 10% = 80
        // marginToVault = closeMarginToVault + requiredNewMargin = = -(25 + 137.87) + 51.515 = -111.355
        // marginToTrader = - marginToVault - fee = 111.355 - 80 = 31.355
        expect(aliceBalance2.sub(aliceBalance1)).eq("31363636363636363637");

        const position = await clearingHouse.getPosition(amm.address, alice.address);
        // total position size = 20 - 62.5 = -42.5
        expect(position.size).to.eq("-42500000000000000001");
        // remain unrealizedPnl = unrealizedPnl - realizedPnl ~= 0
        expect(await clearingHouseViewer.getUnrealizedPnl(amm.address, alice.address, PnlCalcOption.SPOT_PRICE)).eq(-9);
        // alice's 42.5 short position worth 412.12 now
        // (800 + quoteAssetDelta) * (125 - 42.5) = 100k, quoteAssetDelta = 412.121212121212121212
        // openNotional = positionNotional + unrealizedPnl = 412.121212121212121212
        expect(position.openNotional).to.eq("412121212121212121213");
        // requiredNewMargin = remainPositionNotional/newLeverage = 412.12/8 = 51.515
        expect(position.margin).to.eq("51515151515151515151");

        // 25 + 35 + 80 = 140
        expect(await quoteToken.balanceOf(tollPool.address)).to.eq("139999999999999999999");
      });

      it("open long position, price down, then close entire position by opening another larger short", async () => {
        // alice opens long position with 125 margin, 2x leverage
        // (1000 + 250) * (100 + baseAssetDelta) = 100k, baseAssetDelta = -20
        await clearingHouse
          .connect(alice)
          .openPosition(amm.address, Side.BUY, toFullDigitBN(250), toFullDigitBN(2), toFullDigitBN(20), true);
        const aliceBalance1 = await quoteToken.balanceOf(alice.address);

        // bob opens short position with 125 margin, 2x leverage, price down
        // (1250 - 250) * (80 + baseAssetDelta) = 100k, baseAssetDelta = 20
        await clearingHouse
          .connect(bob)
          .openPosition(amm.address, Side.SELL, toFullDigitBN(250), toFullDigitBN(2), toFullDigitBN(20), true);

        // alice's 20 long position worth 166.67 now
        // (1000 + quoteAssetDelta) * (100 + 20) = 100k, quoteAssetDelta = -166.666666666666666666
        // unrealizedPnl = positionValue - cost = 166.666666666666666666 - 250 = -83.333333333333333333
        expect(await clearingHouseViewer.getUnrealizedPnl(amm.address, alice.address, PnlCalcOption.SPOT_PRICE)).eq(
          "-83333333333333333334"
        );

        // alice opens short position with 60 margin, 10x leverage
        // (1000 - 600) * (100 + baseAssetDelta) = 100k, baseAssetDelta = 150
        const receipt = await clearingHouse
          .connect(alice)
          .openPosition(amm.address, Side.SELL, toFullDigitBN(600), toFullDigitBN(10), toFullDigitBN(1450), true);
        const aliceBalance2 = await quoteToken.balanceOf(alice.address);

        // closeRatio = closePositionSize/positionSize = max(1, 150/20) = 100%
        // realizedPnl = unrealizedPnl * closeRatio = -83.333333333333333333
        // closeMargin = currentMargin * closeRatio = 125
        // remainPositionNotional = 600 - 166.67 = 433.33
        // requiredNewMargin = remainPositionNotional / leverage = 433.33 / 10
        // fee = 60 * 10 * 10% = 60
        // marginToTrader = closedMargin - requiredNewMargin - fee + realizedPnl = 125 - 43.33 - 60 + (-83.33) = -61.66
        expect(aliceBalance2.sub(aliceBalance1)).eq("-61666666666666666666");

        const position = await clearingHouse.getPosition(amm.address, alice.address);
        // total position size = 20 - 150 = -130
        expect(position.size).to.eq("-130000000000000000001");
        // remain unrealizedPnl = unrealizedPnl - realizedPnl = 0
        expect(await clearingHouseViewer.getUnrealizedPnl(amm.address, alice.address, PnlCalcOption.SPOT_PRICE)).eq(-3);
        // alice's 130 short position worth 433.33 now
        // (400 + quoteAssetDelta) * (250 - 130) = 100k, quoteAssetDelta = 433.333333333333333333
        // openNotional = positionNotional + unrealizedPnl = 433.333333333333333333 0
        expect(position.openNotional).to.eq("433333333333333333334");
        // total position margin = 433.33 / 10
        expect(position.margin).to.eq("43333333333333333333");
      });

      it("open short position, price up, then close entire position by opening another larger long", async () => {
        // alice opens short position with 200 margin, 1x leverage
        // (1000 - 200) * (100 + baseAssetDelta) = 100k, baseAssetDelta = 25
        await clearingHouse
          .connect(alice)
          .openPosition(amm.address, Side.SELL, toFullDigitBN(200), toFullDigitBN(1), toFullDigitBN(25), true);

        // bob opens long position with 50 margin, 4x leverage. price up
        // (800 + 200) * (125 + baseAssetDelta) = 100k, baseAssetDelta = -25
        // return size might loss 1 wei
        await clearingHouse
          .connect(bob)
          .openPosition(amm.address, Side.BUY, toFullDigitBN(200), toFullDigitBN(4), toFullDigitBN(7.349), true);

        // alice's 25 short position worth 333.333333333333333333 now
        // (1000 + quoteAssetDelta) * (100 - 25) = 100k, quoteAssetDelta = 333.333333333333333333
        // unrealizedPnl = positionValueWhenBorrowed - positionValueWhenReturned = 200 - 333.333333333333333333 = -133.333333333333333333
        expect(await clearingHouseViewer.getUnrealizedPnl(amm.address, alice.address, PnlCalcOption.SPOT_PRICE)).eq(
          "-133333333333333333334"
        );

        // alice opens long position with 60 margin, 10x leverage
        // (1000 + 600) * (100 + baseAssetDelta) = 100k, baseAssetDelta = -37.5
        // return size might loss 1 wei
        await clearingHouse
          .connect(alice)
          .openPosition(amm.address, Side.BUY, toFullDigitBN(600), toFullDigitBN(10), toFullDigitBN(37.49), true);

        const position = await clearingHouse.getPosition(amm.address, alice.address);
        // total position size = 37.5 - 25 = 12.5 - 1 wei
        expect(position.size).to.eq("12499999999999999999");
        // remain unrealizedPnl = 0 because alice already close old position and opens new position in reverse side
        // should be 0 but got -21 due to rounding error
        expect(await clearingHouseViewer.getUnrealizedPnl(amm.address, alice.address, PnlCalcOption.SPOT_PRICE)).eq("-21");

        // alice's 12.5 long position worth 433.33 now
        // (1600 + quoteAssetDelta) * (62.5 + 12.5) = 100k, quoteAssetDelta = -266.666666666666666666
        // openNotional = positionNotional - unrealizedPnl = 266.666666666666666666 - 0
        expect(position.openNotional).to.eq("266666666666666666666");
        // margin is positionNotional / leverage = 26.66
        expect(position.margin).to.eq("26666666666666666666");
      });

      it("open short position, price down, then close entire position by opening another larger long", async () => {
        // given some other traders open some amount of position
        // to prevent vault doesn't have enough collateral to pay profit in this test case
        await transfer(admin, clearingHouse.address, 1000);

        // alice opens short position with 500 margin, 1x leverage
        // (1000 - 500) * (100 + baseAssetDelta) = 100k, baseAssetDelta = 100
        await clearingHouse
          .connect(alice)
          .openPosition(amm.address, Side.SELL, toFullDigitBN(500), toFullDigitBN(1), toFullDigitBN(100), true);
        const aliceBalance1 = await quoteToken.balanceOf(alice.address);

        // bob opens short position with 100 margin, 1x leverage. price down
        // (500 - 100) * (200 + baseAssetDelta) = 100k, baseAssetDelta = 50
        // return size might loss 1 wei
        await clearingHouse
          .connect(bob)
          .openPosition(amm.address, Side.SELL, toFullDigitBN(100), toFullDigitBN(1), toFullDigitBN(50), true);

        // alice's 100 short position worth 266.666666666666666666 now
        // (400 + quoteAssetDelta) * (250 - 100) = 100k, quoteAssetDelta = 266.666666666666666666
        // unrealizedPnl = positionValueWhenBorrowed - positionValueWhenReturned = 500 - 266.666666666666666666 = 233.333333333333333333
        expect(await clearingHouseViewer.getUnrealizedPnl(amm.address, alice.address, PnlCalcOption.SPOT_PRICE)).eq(
          "233333333333333333333"
        );

        // alice opens long position with 60 margin, 10x leverage
        // (400 + 600) * (250 + baseAssetDelta) = 100k, baseAssetDelta = -150
        // return size might loss 1 wei
        const receipt = await clearingHouse
          .connect(alice)
          .openPosition(amm.address, Side.BUY, toFullDigitBN(600), toFullDigitBN(10), toFullDigitBN(149.99), true);
        const aliceBalance2 = await quoteToken.balanceOf(alice.address);

        // closeRatio = closePositionSize/positionSize = 100%
        // realizedPnl = unrealizedPnl * closeRatio = 233.333333333333333333
        // closeMargin = currentMargin * closeRatio = 500
        // remainPositionNotional = 600 - 266.66 = 333.33
        // newRequiredMargin = 333.33 / 10
        // fee = 60 * 10 * 10% = 60
        // then transferred margin = closedMargin - fee + realizedPnl - newRequiredMargin = 500 - 60 + 233.33 - 333.33 = 640
        expect(aliceBalance2.sub(aliceBalance1)).eq("640000000000000000001");

        const position = await clearingHouse.getPosition(amm.address, alice.address);
        // total position size = 150 - 100 = 50 - 1 wei
        expect(position.size).to.eq("49999999999999999999");
        // const pnl = await clearingHouseViewer.getUnrealizedPnl(amm.address, alice, PnlCalcOption.SPOT_PRICE)
        // TODO should be 0 but got 2 wei, rounding error?
        // expect(pnl).eq(0)

        // alice's 50 long position worth 333.33 now
        // (1000 + quoteAssetDelta) * (100 + 50) = 100k, quoteAssetDelta = -333.33
        // openNotional = positionNotional - unrealizedPnl = 333.33 - 0 = 333.33
        expect(position.openNotional).to.eq("333333333333333333333");
        // total position margin = 333.33 / 10
        expect(position.margin).to.eq("33333333333333333333");
      });
    });
  });
});