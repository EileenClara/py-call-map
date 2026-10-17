"""Demo file for manual verification of PyCallMap."""

def factorial(n):
    if n <= 1:
        return 1
    return n * factorial(n - 1)


def load_data(path):
    return open(path, encoding="utf-8").read()


def clean(text):
    return text.strip()


def compute(text):
    return len(clean(text))


def process(path):
    text = load_data(path)
    return compute(text)


class Reporter:
    def __init__(self, name):
        self.name = name

    def report(self, value):
        print(f"{self.name}: {value}")


def unused_helper():
    return 42


def main():
    value = factorial(5)
    process("data.txt")
    Reporter("demo").report(value)


if __name__ == "__main__":
    main()
