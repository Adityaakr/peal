// SPDX-License-Identifier: Apache-2.0
pragma solidity ^0.8.28;

interface IERC20 {
    function transfer(address to, uint256 amount) external returns (bool);
    function transferFrom(address from, address to, uint256 amount) external returns (bool);
    function balanceOf(address who) external view returns (uint256);
}

/// @title SwapPool
/// @notice A constant-product (x*y=k) AMM with a 0.05% fee, holding
/// two ERC-20 reserves. Swaps are gated to a single immutable `operator` (the
/// block builder allowed to move the pool). Deploy it twice:
///   - public lane: operator = PublicBuilder (an unprotected mempool)
///   - peal lane:   operator = PealMempool  (opens only the sealed batch)
/// Same math, same gate, so the only difference the demo shows between the two
/// lanes is whether the order was readable before it executed.
contract SwapPool {
    IERC20 public immutable base; // e.g. mUSDC
    IERC20 public immutable quote; // e.g. mETH

    uint256 public reserveBase;
    uint256 public reserveQuote;

    /// @notice The only address allowed to call swap(): the lane's builder. Set
    /// once after deploy, because the pool and its builder reference each other
    /// (the pool cannot know the builder's address until the builder, which
    /// takes the pool in its constructor, exists).
    address public operator;

    /// @notice May reset reserves via adminSetReserves. The demo resets both
    /// lanes to identical reserves before each swap, so the only difference
    /// between them is the sandwich, never independent pool drift.
    address public immutable admin;

    /// @notice 0.05%, the tier ETH/USDC actually trades at on uniswap v3 at
    /// size. NOT the v2 0.30% general-purpose tier: at 0.30% the quote gap a
    /// visitor sees can never beat 2x the fee while a sandwich is still
    /// profitable (gap = fee + swap/depth, and profit needs swap/depth > fee),
    /// so 0.30% put a 0.60% floor under the demo's own quote. The denominator
    /// is 10000, not 1000: 0.05% is inexpressible in thousandths, and setting
    /// FEE_NUM = 9995 while leaving FEE_DEN = 1000 mints a NEGATIVE fee.
    /// Mirrored in mempool-agents/src/sandwich.ts and explorer/src/mempool/
    /// chain.ts; all three must move together or the browser quote and the
    /// searcher's revert-wall bisection silently diverge from execution.
    uint256 internal constant FEE_NUM = 9995;
    uint256 internal constant FEE_DEN = 10000;

    event Swapped(
        address indexed payer,
        bool baseToQuote,
        uint256 amountIn,
        uint256 amountOut,
        address indexed to
    );

    error NotOperator();
    error OperatorAlreadySet();
    error NotAdmin();
    error ZeroAmount();
    error Slippage(uint256 got, uint256 minOut);

    constructor(IERC20 base_, IERC20 quote_, address admin_) {
        base = base_;
        quote = quote_;
        admin = admin_;
    }

    /// @notice Reset reserves to exact targets, pulling any deficit from the
    /// admin (who must approve this pool) and returning any surplus. Called
    /// before each demo swap so both lanes start identical.
    function adminSetReserves(uint256 baseTarget, uint256 quoteTarget) external {
        if (msg.sender != admin) revert NotAdmin();
        _reconcile(base, reserveBase, baseTarget);
        _reconcile(quote, reserveQuote, quoteTarget);
        reserveBase = baseTarget;
        reserveQuote = quoteTarget;
    }

    function _reconcile(IERC20 token, uint256 current, uint256 target) internal {
        if (target > current) {
            _check(token.transferFrom(admin, address(this), target - current));
        } else if (current > target) {
            _check(token.transfer(admin, current - target));
        }
    }

    /// @notice Wire the builder that owns this pool. Callable once.
    function initOperator(address operator_) external {
        if (operator != address(0)) revert OperatorAlreadySet();
        operator = operator_;
    }

    /// @notice Seed reserves. Caller must have transferred the tokens in first
    /// (the deploy script mints to the pool, then calls this to record them).
    function sync() external {
        reserveBase = base.balanceOf(address(this));
        reserveQuote = quote.balanceOf(address(this));
    }

    /// @notice Constant-product quote net of the 0.05% fee.
    function getAmountOut(uint256 amountIn, uint256 reserveIn, uint256 reserveOut)
        public
        pure
        returns (uint256)
    {
        if (amountIn == 0) return 0;
        uint256 inWithFee = amountIn * FEE_NUM;
        return (reserveOut * inWithFee) / (reserveIn * FEE_DEN + inWithFee);
    }

    /// @notice Execute one swap, pulling `amountIn` of the input token from
    /// `payer` (who must have approved this pool) and sending the output to
    /// `to`. Reverts if the output falls below `minOut` — that revert floor is
    /// exactly what a sandwich pushes a victim to on the public lane.
    function swap(address payer, bool baseToQuote, uint256 amountIn, uint256 minOut, address to)
        external
        returns (uint256 amountOut)
    {
        if (msg.sender != operator) revert NotOperator();
        if (amountIn == 0) revert ZeroAmount();

        (IERC20 tokenIn, IERC20 tokenOut, uint256 reserveIn, uint256 reserveOut) = baseToQuote
            ? (base, quote, reserveBase, reserveQuote)
            : (quote, base, reserveQuote, reserveBase);

        amountOut = getAmountOut(amountIn, reserveIn, reserveOut);
        if (amountOut < minOut) revert Slippage(amountOut, minOut);

        _check(tokenIn.transferFrom(payer, address(this), amountIn));
        _check(tokenOut.transfer(to, amountOut));

        if (baseToQuote) {
            reserveBase = reserveIn + amountIn;
            reserveQuote = reserveOut - amountOut;
        } else {
            reserveQuote = reserveIn + amountIn;
            reserveBase = reserveOut - amountOut;
        }

        emit Swapped(payer, baseToQuote, amountIn, amountOut, to);
    }

    error TransferFailed();

    function _check(bool ok) internal pure {
        if (!ok) revert TransferFailed();
    }
}
