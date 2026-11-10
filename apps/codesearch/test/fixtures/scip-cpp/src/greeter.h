#pragma once

#include <string>

namespace fixture {

class Greeter {
 public:
  explicit Greeter(std::string name);
  std::string greet() const;

 private:
  std::string name_;
};

}  // namespace fixture
