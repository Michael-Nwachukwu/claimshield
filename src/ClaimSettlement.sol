// SPDX-License-Identifier: MIT
pragma solidity ^0.8.20;

import "@openzeppelin/contracts/token/ERC20/IERC20.sol";

/// @title ClaimSettlement
/// @notice Holds the insurer's USDC liquidity pool and executes payouts.
///
/// @dev Authorization pattern (Option C from implementation plan):
///      The enclave calls BOTH `PolicyRegistry.recordVerdict()` AND
///      `ClaimSettlement.executePayout()` directly. This means the enclave
///      must be authorised here as well. We store the approvedEnclave address
///      and gate executePayout behind it.
///
///      This is more accurate than the SCOPE.MD's onlyRegistry pattern because:
///      - PolicyRegistry doesn't know about ClaimSettlement (better separation of concerns)
///      - The enclave is the single source of truth for verdict + payout atomicity
///      - Matches how the CRE WriteTarget would work in a production deployment
contract ClaimSettlement {
    IERC20 public immutable usdc;
    address public immutable owner;
    address public approvedEnclave;

    event LiquidityDeposited(address indexed depositor, uint256 amount);
    event PayoutExecuted(
        bytes32 indexed policyId,
        address indexed recipient,
        uint256 amount
    );
    event ClaimDenied(bytes32 indexed policyId, uint8 reasonCode);
    event EnclaveUpdated(
        address indexed oldEnclave,
        address indexed newEnclave
    );

    modifier onlyApprovedEnclave() {
        require(
            msg.sender == approvedEnclave,
            "ClaimSettlement: not approved enclave"
        );
        _;
    }

    modifier onlyOwner() {
        require(msg.sender == owner, "ClaimSettlement: not owner");
        _;
    }

    constructor(address _usdc, address _approvedEnclave) {
        require(_usdc != address(0), "ClaimSettlement: invalid USDC address");
        require(
            _approvedEnclave != address(0),
            "ClaimSettlement: invalid enclave address"
        );
        usdc = IERC20(_usdc);
        approvedEnclave = _approvedEnclave;
        owner = msg.sender;
    }

    /// @notice The insurer deposits USDC to fund the settlement pool.
    ///         Must call `usdc.approve(address(this), amount)` first.
    function depositLiquidity(uint256 amount) external {
        require(amount > 0, "ClaimSettlement: amount must be non-zero");
        bool success = usdc.transferFrom(msg.sender, address(this), amount);
        require(success, "ClaimSettlement: transfer failed");
        emit LiquidityDeposited(msg.sender, amount);
    }

    /// @notice Execute a USDC payout to the claimant.
    ///         Called directly by the CRE enclave after recording a verdict in PolicyRegistry.
    ///         Only the approved enclave address can call this — ensures payouts only
    ///         happen after the TEE has verified the claim against the live FHIR API.
    /// @param policyId  The adjudicated policy (for event indexing)
    /// @param recipient The claimant's wallet address
    /// @param amount    USDC amount to transfer (6 decimal places)
    function executePayout(
        bytes32 policyId,
        address recipient,
        uint256 amount
    ) external onlyApprovedEnclave {
        require(recipient != address(0), "ClaimSettlement: invalid recipient");
        require(amount > 0, "ClaimSettlement: payout amount must be non-zero");
        require(
            usdc.balanceOf(address(this)) >= amount,
            "ClaimSettlement: insufficient liquidity"
        );

        bool success = usdc.transfer(recipient, amount);
        require(success, "ClaimSettlement: payout transfer failed");

        emit PayoutExecuted(policyId, recipient, amount);
    }

    /// @notice Emit a denial event for record-keeping (called by enclave for denied claims).
    function recordDenial(
        bytes32 policyId,
        uint8 reasonCode
    ) external onlyApprovedEnclave {
        emit ClaimDenied(policyId, reasonCode);
    }

    /// @notice Allow the owner to update the approved enclave address.
    ///         Required if the CRE DON rotates enclave keys.
    function setApprovedEnclave(address newEnclave) external onlyOwner {
        require(
            newEnclave != address(0),
            "ClaimSettlement: invalid enclave address"
        );
        emit EnclaveUpdated(approvedEnclave, newEnclave);
        approvedEnclave = newEnclave;
    }

    /// @notice View the current USDC pool balance.
    function poolBalance() external view returns (uint256) {
        return usdc.balanceOf(address(this));
    }
}
