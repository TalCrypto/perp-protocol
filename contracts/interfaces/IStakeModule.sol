// SPDX-License-Identifier: GPL-3.0-or-later
pragma solidity 0.8.9;

interface IStakeModule {
    function notifyStakeChanged(address staker) external;
}