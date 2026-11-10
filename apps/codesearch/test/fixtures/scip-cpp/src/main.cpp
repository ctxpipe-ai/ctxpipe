#include <iostream>

#include "greeter.h"

int main() {
  fixture::Greeter greeter("ctxpipe");
  std::cout << greeter.greet() << std::endl;
  return 0;
}
