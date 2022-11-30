import { expect, use } from "chai";
import { Signer, BigNumber } from "ethers";
import { ethers } from "hardhat";
import { solidity } from "ethereum-waffle";
import {
  AmmFake,
  ClearingHouseFake,
  ClearingHouseViewer,
  ERC20Fake,
  InsuranceFundFake,
  TraderWallet__factory,
  TraderWallet,
  L2PriceFeedMock,
} from "../../../typechain-types";
import { PnlCalcOption, Side } from "../../../utils/contract";
import { fullDeploy } from "../../../utils/deploy";
import { toFullDigitBN } from "../../../utils/number";
import { SignerWithAddress } from "@nomiclabs/hardhat-ethers/signers";
import { loadFixture } from "@nomicfoundation/hardhat-network-helpers";

describe("ClearingHouse Test", () => {
  let admin: SignerWithAddress;
  let alice: SignerWithAddress;
  let bob: SignerWithAddress;
  let carol: SignerWithAddress;
  let relayer: SignerWithAddress;

  let amm: AmmFake;
  let insuranceFund: InsuranceFundFake;
  let quoteToken: ERC20Fake;
  let mockPriceFeed!: L2PriceFeedMock;
  let clearingHouse: ClearingHouseFake;
  let clearingHouseViewer: ClearingHouseViewer;

  let traderWallet1: TraderWallet;
  let traderWallet2: TraderWallet;

  async function gotoNextFundingTime(): Promise<void> {
    const nextFundingTime = await amm.nextFundingTime();
    await amm.mock_setBlockTimestamp(nextFundingTime);
    await mockPriceFeed.setLatestTimestamp(nextFundingTime);
  }

  async function forwardBlockTimestamp(time: number): Promise<void> {
    const now = await amm.mock_getCurrentTimestamp();
    const newTime = now.add(time);
    await amm.mock_setBlockTimestamp(newTime);
    await clearingHouse.mock_setBlockTimestamp(newTime);
    const movedBlocks = time / 15 < 1 ? 1 : time / 15;

    const blockNumber = await amm.mock_getCurrentBlockNumber();
    const newBlockNumber = blockNumber.add(movedBlocks);
    await amm.mock_setBlockNumber(newBlockNumber);
    await clearingHouse.mock_setBlockNumber(newBlockNumber);
  }

  async function endEpoch(): Promise<void> {
    //await forwardBlockTimestamp((await supplySchedule.mintDuration()).toNumber())
    //await minter.mintReward()
  }

  async function approve(account: Signer, spender: string, amount: number): Promise<void> {
    await quoteToken.connect(account).approve(spender, toFullDigitBN(amount, +(await quoteToken.decimals())));
  }

  async function transfer(from: Signer, to: string, amount: number): Promise<void> {
    await quoteToken.connect(from).transfer(to, toFullDigitBN(amount, +(await quoteToken.decimals())));
  }

  function toBytes32(str: string): string {
    const paddingLen = 32 - str.length;
    const hex = ethers.utils.formatBytes32String(str);
    return hex + "00".repeat(paddingLen);
  }

  async function syncAmmPriceToOracle() {
    const marketPrice = await amm.getSpotPrice();
    await mockPriceFeed.setTwapPrice(marketPrice);
  }

  async function deployEnvFixture() {
    const contracts = await fullDeploy({ sender: admin });
    const amm = contracts.amm;
    const insuranceFund = contracts.insuranceFund;
    const quoteToken = contracts.quoteToken;
    const mockPriceFeed = contracts.priceFeed;
    const clearingHouse = contracts.clearingHouse;
    const clearingHouseViewer = contracts.clearingHouseViewer;

    // Each of Alice & Bob have 5000 DAI
    await quoteToken.transfer(alice.address, toFullDigitBN(5000, +(await quoteToken.decimals())));
    await quoteToken.transfer(bob.address, toFullDigitBN(5000, +(await quoteToken.decimals())));
    await quoteToken.transfer(insuranceFund.address, toFullDigitBN(5000, +(await quoteToken.decimals())));

    await amm.setCap(toFullDigitBN(0), toFullDigitBN(0));
    await amm.setAdjustable(true);
    await amm.setCanLowerK(true);

    const marketPrice = await amm.getSpotPrice();
    await mockPriceFeed.setTwapPrice(marketPrice);
    return { amm, insuranceFund, quoteToken, mockPriceFeed, clearingHouse, clearingHouseViewer };
  }

  beforeEach(async () => {
    [admin, alice, bob, carol, relayer] = await ethers.getSigners();
    const fixture = await loadFixture(deployEnvFixture);
    amm = fixture.amm;
    insuranceFund = fixture.insuranceFund;
    quoteToken = fixture.quoteToken;
    mockPriceFeed = fixture.mockPriceFeed;
    clearingHouse = fixture.clearingHouse;
    clearingHouseViewer = fixture.clearingHouseViewer;
  });

  describe("manual repeg test when position size = -25", () => {
    beforeEach(async () => {
      await amm.setSpreadRatio(toFullDigitBN(0.1));
      // given alice takes 2x long position (20B) with 125 margin
      await approve(alice, clearingHouse.address, 250);
      await clearingHouse.connect(alice).openPosition(amm.address, Side.BUY, toFullDigitBN(250), toFullDigitBN(2), toFullDigitBN(0), true);
      // B = 80, Q = 1250

      // given bob takes 1x short position (-45B) with 450 margin
      await approve(bob, clearingHouse.address, 900);
      await clearingHouse.connect(bob).openPosition(amm.address, Side.SELL, toFullDigitBN(450), toFullDigitBN(1), toFullDigitBN(0), true);
      // B = 125, Q = 800
      expect(await amm.quoteAssetReserve()).eql(toFullDigitBN(800));
      expect(await amm.baseAssetReserve()).eql(toFullDigitBN(125));
      expect(await amm.getBaseAssetDelta()).eql(toFullDigitBN(-25));

      const clearingHouseBaseTokenBalance = await quoteToken.balanceOf(clearingHouse.address);
      // 125 (alice's margin) + 450 (bob' margin)  = 575
      expect(clearingHouseBaseTokenBalance).eq(toFullDigitBN(575));
      expect(await clearingHouse.totalFees(amm.address)).eq(toFullDigitBN(70));
      expect(await clearingHouse.totalMinusFees(amm.address)).eq(toFullDigitBN(70));
    });
    it("fail to repeg because of not a operator", async () => {
      await expect(clearingHouse.repegAmm(amm.address, toFullDigitBN(100))).to.revertedWith("caller is not operator");
    });
    it("success to increase mark price with revenue", async () => {
      await clearingHouse.setOperator(admin.address);
      const tx = await clearingHouse.repegAmm(amm.address, toFullDigitBN(900));
      // cost = 800 * 25 / 100 - 900 * 25 / 100 = -25
      await expect(tx).to.emit(clearingHouse, "Repeg").withArgs(amm.address, toFullDigitBN(900), toFullDigitBN(125), toFullDigitBN(-25));
      expect(await amm.quoteAssetReserve()).eql(toFullDigitBN(900));
      expect(await amm.baseAssetReserve()).eql(toFullDigitBN(125));
      expect(await clearingHouse.totalMinusFees(amm.address)).eq(toFullDigitBN(95));
    });
    it("success to decrease mark price with expense", async () => {
      await clearingHouse.setOperator(admin.address);
      const tx = await clearingHouse.repegAmm(amm.address, toFullDigitBN(700));
      // cost = 800 * 25 / 100 - 700 * 25 / 100 = 25
      await expect(tx).to.emit(clearingHouse, "Repeg").withArgs(amm.address, toFullDigitBN(700), toFullDigitBN(125), toFullDigitBN(25));
      expect(await amm.quoteAssetReserve()).eql(toFullDigitBN(700));
      expect(await amm.baseAssetReserve()).eql(toFullDigitBN(125));
      expect(await clearingHouse.totalMinusFees(amm.address)).eq(toFullDigitBN(45));
    });
    it("fail to decrease mark price with expense more than half of fee pool", async () => {
      await clearingHouse.setOperator(admin.address);
      await expect(clearingHouse.repegAmm(amm.address, toFullDigitBN(600))).to.revertedWith("insufficient fee pool");
    });
  });

  describe("manual k-adjustment test when position size = -25", () => {
    beforeEach(async () => {
      await amm.setSpreadRatio(toFullDigitBN(0.1));
      // given alice takes 2x long position (20B) with 125 margin
      await approve(alice, clearingHouse.address, 250);
      await clearingHouse.connect(alice).openPosition(amm.address, Side.BUY, toFullDigitBN(250), toFullDigitBN(2), toFullDigitBN(0), true);
      // B = 80, Q = 1250

      // given bob takes 1x short position (-45B) with 450 margin
      await approve(bob, clearingHouse.address, 900);
      await clearingHouse.connect(bob).openPosition(amm.address, Side.SELL, toFullDigitBN(450), toFullDigitBN(1), toFullDigitBN(0), true);
      // B = 125, Q = 800
      expect(await amm.quoteAssetReserve()).eql(toFullDigitBN(800));
      expect(await amm.baseAssetReserve()).eql(toFullDigitBN(125));
      expect(await amm.getBaseAssetDelta()).eql(toFullDigitBN(-25));

      const clearingHouseBaseTokenBalance = await quoteToken.balanceOf(clearingHouse.address);
      // 125 (alice's margin) + 450 (bob' margin)  = 575
      expect(clearingHouseBaseTokenBalance).eq(toFullDigitBN(575));
      expect(await clearingHouse.totalFees(amm.address)).eq(toFullDigitBN(70));
      expect(await clearingHouse.totalMinusFees(amm.address)).eq(toFullDigitBN(70));
    });
    it("fail to repeg because of not a operator", async () => {
      await expect(clearingHouse.adjustK(amm.address, toFullDigitBN(1), toFullDigitBN(1))).to.revertedWith("caller is not operator");
    });
    it("success to increase k by 0.1 with expense", async () => {
      await clearingHouse.setOperator(admin.address);
      const tx = await clearingHouse.adjustK(amm.address, toFullDigitBN(11), toFullDigitBN(10));
      // cost = (800*125/(125-25)-800) - (880*137.5/(137.5-25)-880) = 4.444
      await expect(tx)
        .to.emit(clearingHouse, "UpdateK")
        .withArgs(amm.address, toFullDigitBN(880), toFullDigitBN(137.5), "4444444444444444445");
      expect(await amm.quoteAssetReserve()).eql(toFullDigitBN(880));
      expect(await amm.baseAssetReserve()).eql(toFullDigitBN(137.5));
      expect(await clearingHouse.totalMinusFees(amm.address)).eq("65555555555555555555");
    });
    it("success to decrease k with revenue", async () => {
      await clearingHouse.setOperator(admin.address);
      const tx = await clearingHouse.adjustK(amm.address, toFullDigitBN(9), toFullDigitBN(10));
      // cost = (800*125/(125-25)-800) - (720*112.5/(112.5-25)-720) = -5.7142857142857
      await expect(tx)
        .to.emit(clearingHouse, "UpdateK")
        .withArgs(amm.address, toFullDigitBN(720), toFullDigitBN(112.5), "-5714285714285714285");
      expect(await amm.quoteAssetReserve()).eql(toFullDigitBN(720));
      expect(await amm.baseAssetReserve()).eql(toFullDigitBN(112.5));
      expect(await clearingHouse.totalMinusFees(amm.address)).eq("75714285714285714285");
    });
    it("fail to increase k with expense more than half of fee pool", async () => {
      await clearingHouse.setOperator(admin.address);
      await expect(clearingHouse.adjustK(amm.address, toFullDigitBN(100), toFullDigitBN(10))).to.revertedWith("insufficient fee pool");
    });
  });

  describe("payFunding: when alice.size = 20 & bob.size = -45 (long < short) and fee pool > 0", () => {
    beforeEach(async () => {
      await amm.setSpreadRatio(toFullDigitBN(0.5));
      // given alice takes 2x long position (20B) with 125 margin
      await approve(alice, clearingHouse.address, 250);
      await clearingHouse.connect(alice).openPosition(amm.address, Side.BUY, toFullDigitBN(250), toFullDigitBN(2), toFullDigitBN(0), true);
      // B = 80, Q = 1250

      // given bob takes 1x short position (-45B) with 450 margin
      await approve(bob, clearingHouse.address, 900);
      await clearingHouse.connect(bob).openPosition(amm.address, Side.SELL, toFullDigitBN(450), toFullDigitBN(1), toFullDigitBN(0), true);
      // B = 125, Q = 800

      //mark_twap = 6.4

      const clearingHouseBaseTokenBalance = await quoteToken.balanceOf(clearingHouse.address);
      // 125 (alice's margin) + 450 (bob' margin)  = 575
      expect(clearingHouseBaseTokenBalance).eq(toFullDigitBN(575));
      expect(await clearingHouse.netRevenuesSinceLastFunding(amm.address)).eq(toFullDigitBN(350));
    });

    describe("when oracle-mark divergence doesn't exceed limit", () => {
      beforeEach(async () => {
        await syncAmmPriceToOracle();
      });
      describe("when oracle twap is higher than mark twap", () => {
        beforeEach(async () => {
          await mockPriceFeed.setTwapPrice(toFullDigitBN(6.5));
        });
        it("should increase k because funding payment is positive", async () => {
          await gotoNextFundingTime();
          // funding imbalance cost = 2
          await clearingHouse.payFunding(amm.address);
          expect(await clearingHouse.getLatestCumulativePremiumFraction(amm.address)).eq(toFullDigitBN(-0.1));
          const baseAssetReserve = ethers.utils.formatEther(await amm.baseAssetReserve());
          const quoteAssetReserve = ethers.utils.formatEther(await amm.quoteAssetReserve());
          expect(Number(baseAssetReserve) / 125).above(1);
          expect(Number(quoteAssetReserve) / 800).above(1);
          expect(Number(baseAssetReserve) / 125).eq(Number(quoteAssetReserve) / 800);
        });
      });
      describe("when oracle twap is lower than mark twap", () => {
        beforeEach(async () => {
          await mockPriceFeed.setTwapPrice(toFullDigitBN(6.3));
        });
        it("k-adjustment doesn't occur because funding cost is negative and it's absolute value is smaller than net revenue", async () => {
          await gotoNextFundingTime();
          // funding imbalance cost = -2
          await clearingHouse.payFunding(amm.address);
          expect(await clearingHouse.getLatestCumulativePremiumFraction(amm.address)).eq(toFullDigitBN(0.1));
          const baseAssetReserve = ethers.utils.formatEther(await amm.baseAssetReserve());
          const quoteAssetReserve = ethers.utils.formatEther(await amm.quoteAssetReserve());
          expect(Number(baseAssetReserve) / 125).eq(1);
          expect(Number(quoteAssetReserve) / 800).eq(1);
        });
      });
    });

    describe("when oracle-mark divergence exceeds limit", () => {
      // mark = 6.4, oralce = 10
      beforeEach(async () => {
        await forwardBlockTimestamp(15);
      });
      describe("when oracle twap is higher than mark twap", () => {
        beforeEach(async () => {
          await mockPriceFeed.setTwapPrice(toFullDigitBN(8));
        });
        it("repeg occurs", async () => {
          await gotoNextFundingTime();
          await clearingHouse.payFunding(amm.address);
          const quoteAssetReserve = await amm.quoteAssetReserve();
          const baseAssetReserve = await amm.baseAssetReserve();
          expect(quoteAssetReserve.div(baseAssetReserve)).eq(8);
        });
        it("should increase k because funding payment is positive", async () => {
          await gotoNextFundingTime();
          // funding imbalance cost = 2
          await clearingHouse.payFunding(amm.address);
          expect(await clearingHouse.getLatestCumulativePremiumFraction(amm.address)).eq(toFullDigitBN(-1.6));
          const baseAssetReserve = ethers.utils.formatEther(await amm.baseAssetReserve());
          const quoteAssetReserve = ethers.utils.formatEther(await amm.quoteAssetReserve());
          expect(Number(baseAssetReserve) / 125).above(1);
          expect(Number(quoteAssetReserve) / 1000).above(1);
        });
      });
      describe("when oracle twap is lower than mark twap", () => {
        beforeEach(async () => {
          await mockPriceFeed.setTwapPrice(toFullDigitBN(5));
        });
        it("repeg occurs", async () => {
          await gotoNextFundingTime();
          await clearingHouse.payFunding(amm.address);
          const quoteAssetReserve = await amm.quoteAssetReserve();
          const baseAssetReserve = await amm.baseAssetReserve();
          expect(quoteAssetReserve.div(baseAssetReserve)).eq(5);
        });
        it("k-adjustment doesn't occur because funding cost is negative and it's absolute value is smaller than net revenue", async () => {
          await gotoNextFundingTime();
          // funding imbalance cost = -2
          await clearingHouse.payFunding(amm.address);
          expect(await clearingHouse.getLatestCumulativePremiumFraction(amm.address)).eq(toFullDigitBN(1.4));
          const baseAssetReserve = ethers.utils.formatEther(await amm.baseAssetReserve());
          const quoteAssetReserve = ethers.utils.formatEther(await amm.quoteAssetReserve());
          expect(Number(baseAssetReserve) / 125).eq(1);
          expect(Number(quoteAssetReserve) / 625).eq(1);
        });
      });
    });
  });

  describe("payFunding: when alice.size = 37.5 & bob.size = -17.5 (long > short) and fee pool = 0", () => {
    beforeEach(async () => {
      // given alice takes 2x long position (37.5B) with 300 margin
      await approve(alice, clearingHouse.address, 600);
      await clearingHouse
        .connect(alice)
        .openPosition(amm.address, Side.BUY, toFullDigitBN(600), toFullDigitBN(2), toFullDigitBN(37.5), true);
      // B = 62.5, Q = 1600

      // given bob takes 1x short position (-17.5B) with 350 margin
      await approve(bob, clearingHouse.address, 500);
      await clearingHouse.connect(bob).openPosition(amm.address, Side.SELL, toFullDigitBN(350), toFullDigitBN(1), toFullDigitBN(500), true);
      // B = 80, Q = 1250

      // mark_twap = 15.625

      const clearingHouseBaseTokenBalance = await quoteToken.balanceOf(clearingHouse.address);
      // 300 (alice's margin) + 350 (bob' margin) = 650
      expect(clearingHouseBaseTokenBalance).eq(toFullDigitBN(650));
      await syncAmmPriceToOracle();
    });

    describe("when oracle twap is higher than mark twap", () => {
      beforeEach(async () => {
        await mockPriceFeed.setTwapPrice(toFullDigitBN(15.725));
      });
      it("should decrease K and funding payment 0", async () => {
        await gotoNextFundingTime();
        expect(await clearingHouse.netRevenuesSinceLastFunding(amm.address)).eq(toFullDigitBN(0));
        // uncapped funding imbalance cost = -2
        await clearingHouse.payFunding(amm.address);
        expect(await clearingHouse.getLatestCumulativePremiumFraction(amm.address)).eq(toFullDigitBN(0));
        const baseAssetReserve = ethers.utils.formatEther(await amm.baseAssetReserve());
        const quoteAssetReserve = ethers.utils.formatEther(await amm.quoteAssetReserve());
        expect(Number(baseAssetReserve) / 80).below(1);
        expect(Number(quoteAssetReserve) / 1250).below(1);
      });
    });

    describe("when oracle twap is lower than mark twap", () => {
      beforeEach(async () => {
        await mockPriceFeed.setTwapPrice(toFullDigitBN(15.525));
      });
      it("should increase k because funding payment is positive", async () => {
        await gotoNextFundingTime();
        expect(await clearingHouse.netRevenuesSinceLastFunding(amm.address)).eq(toFullDigitBN(0));
        // funding imbalance cost = 2
        await clearingHouse.payFunding(amm.address);
        expect(await clearingHouse.getLatestCumulativePremiumFraction(amm.address)).eq(toFullDigitBN(0.1));
        const baseAssetReserve = ethers.utils.formatEther(await amm.baseAssetReserve());
        const quoteAssetReserve = ethers.utils.formatEther(await amm.quoteAssetReserve());
        expect(Number(baseAssetReserve) / 80).above(1);
        expect(Number(quoteAssetReserve) / 1250).above(1);
        expect(Number(quoteAssetReserve) / Number(baseAssetReserve)).eq(15.625);
      });
    });
  });

  describe("payFunding: when alice.size = 0.019996 & bob.size = -0.009997", () => {
    let quoteAssetReserveBefore: BigNumber;
    let baseAssetReserveBefore: BigNumber;
    beforeEach(async () => {
      // given alice takes 2x long position (0.019996B) with 0.1 margin
      await approve(alice, clearingHouse.address, 1);
      await clearingHouse.connect(alice).openPosition(amm.address, Side.BUY, toFullDigitBN(0.2), toFullDigitBN(2), toFullDigitBN(0), true);
      // B = 99.98000399920016, Q = 1000.2.

      // given bob takes 1x short position (-0.009997B) with 0.1 margin
      await approve(bob, clearingHouse.address, 500);
      await clearingHouse.connect(bob).openPosition(amm.address, Side.SELL, toFullDigitBN(0.1), toFullDigitBN(1), toFullDigitBN(0), true);
      // B = 99.99000099990001, Q = 1000.1
      baseAssetReserveBefore = await amm.baseAssetReserve();
      quoteAssetReserveBefore = await amm.quoteAssetReserve();
      const clearingHouseBaseTokenBalance = await quoteToken.balanceOf(clearingHouse.address);
      // 0.1 (alice's margin) + 0.1 (bob' margin) = 0.2
      expect(clearingHouseBaseTokenBalance).eq(toFullDigitBN(0.2));
      await syncAmmPriceToOracle();
    });

    describe("when oracle twap is higher than mark twap", () => {
      beforeEach(async () => {
        await mockPriceFeed.setTwapPrice(toFullDigitBN(10.1));
      });
      it("decrease K and funding payment 0", async () => {
        await gotoNextFundingTime();
        expect(await clearingHouse.netRevenuesSinceLastFunding(amm.address)).eq(toFullDigitBN(0));
        await clearingHouse.payFunding(amm.address);
        const fraction = await clearingHouse.getLatestCumulativePremiumFraction(amm.address);
        const positionSize = await amm.getBaseAssetDelta();
        expect(fraction.mul(positionSize)).eq(toFullDigitBN(0));
        const baseAssetReserve = await amm.baseAssetReserve();
        const quoteAssetReserve = await amm.quoteAssetReserve();
        expect(baseAssetReserve.mul(toFullDigitBN(1)).div(baseAssetReserveBefore)).below(toFullDigitBN(1));
        expect(quoteAssetReserve.mul(toFullDigitBN(1)).div(quoteAssetReserveBefore)).below(toFullDigitBN(1));
        expect(baseAssetReserve.mul(toFullDigitBN(1)).div(baseAssetReserveBefore)).eq(
          quoteAssetReserve.mul(toFullDigitBN(1)).div(quoteAssetReserveBefore)
        );
      });
    });

    describe("when oracle twap is lower than mark twap", () => {
      beforeEach(async () => {
        await mockPriceFeed.setTwapPrice(toFullDigitBN(9.9));
      });
      it("decrease K because total position size is positive and oracle > mark", async () => {
        await gotoNextFundingTime();
        expect(await clearingHouse.netRevenuesSinceLastFunding(amm.address)).eq(toFullDigitBN(0));
        await clearingHouse.payFunding(amm.address);
        const baseAssetReserve = await amm.baseAssetReserve();
        const quoteAssetReserve = await amm.quoteAssetReserve();
        expect(baseAssetReserve.mul(toFullDigitBN(1)).div(baseAssetReserveBefore)).below(toFullDigitBN(1));
        expect(quoteAssetReserve.mul(toFullDigitBN(1)).div(quoteAssetReserveBefore)).below(toFullDigitBN(1));
        expect(baseAssetReserve.mul(toFullDigitBN(1)).div(baseAssetReserveBefore)).eq(
          quoteAssetReserve.mul(toFullDigitBN(1)).div(quoteAssetReserveBefore)
        );
      });
    });
  });
});