# typed: true

module Fixture
  class Greeter
    def initialize(name)
      @name = name
    end

    def greet
      "Hello, #{@name}"
    end
  end
end
