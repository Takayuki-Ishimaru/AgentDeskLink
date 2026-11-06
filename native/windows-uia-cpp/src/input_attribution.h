#pragma once
#include <cstdint>

namespace adl {
// Low-level hook attribution is deliberately physical-only. Unrecognized
// injected events remain interference for interactive input, but cannot be
// used to explain a semantic focus/cursor change as human activity.
constexpr bool IsPhysicalInput(std::uint32_t flags, std::uint32_t injected_flag) noexcept {
  return (flags & injected_flag) == 0;
}
}  // namespace adl
