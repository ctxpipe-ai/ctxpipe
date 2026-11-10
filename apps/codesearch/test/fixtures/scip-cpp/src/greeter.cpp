#include "greeter.h"

#include <utility>

namespace fixture {

Greeter::Greeter(std::string name) : name_(std::move(name)) {}

std::string Greeter::greet() const { return "Hello, " + name_; }

}  // namespace fixture
