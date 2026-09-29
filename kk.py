import random
# установка "зерна" датчика случайных чисел, чтобы получались одни и те же случайные величины
random.seed(1)
n = input().split()
a = random.sample(n , 3)
print(a)