def fibonacci(n):
    """Return the n-th term of the Fibonacci sequence (0-indexed)."""
    if n < 0:
        raise ValueError("n must be a non-negative integer")
    if n == 0:
        return 0

    a, b = 0, 1
    for _ in range(n):
        a, b = b, a + b
    return a


if __name__ == "__main__":
    for i in range(10):
        print(f"fibonacci({i}) = {fibonacci(i)}")
