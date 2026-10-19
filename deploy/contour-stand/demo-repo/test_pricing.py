import unittest

from pricing import total


class TotalTest(unittest.TestCase):
    def test_without_discount(self):
        self.assertEqual(total([(100.0, 2), (50.5, 1)]), 250.5)

    def test_discount_in_percent(self):
        self.assertEqual(total([(100.0, 2)], discount_percent=10), 180.0)


if __name__ == "__main__":
    unittest.main()
