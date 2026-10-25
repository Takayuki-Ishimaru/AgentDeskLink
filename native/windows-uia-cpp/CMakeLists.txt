# AgentDeskLink Windows native UIA helper (C++/COM, MSVC + Windows SDK).
cmake_minimum_required(VERSION 3.24)
project(adl_windows_uia_cpp LANGUAGES CXX)

set(CMAKE_CXX_STANDARD 17)
set(CMAKE_CXX_STANDARD_REQUIRED ON)
set(CMAKE_CXX_EXTENSIONS OFF)
enable_testing()
add_executable(adl_value_text_tests tests/value_text_tests.cpp)
target_include_directories(adl_value_text_tests PRIVATE src)
if(MSVC)
  target_compile_options(adl_value_text_tests PRIVATE /utf-8)
endif()
add_test(NAME rich_edit_value_contract COMMAND adl_value_text_tests)
set_tests_properties(rich_edit_value_contract PROPERTIES TIMEOUT 10)

# --- nlohmann/json pinned to the verified 3.11.3 commit ---------------------
include(FetchContent)
FetchContent_Declare(
  nlohmann_json
  GIT_REPOSITORY https://github.com/nlohmann/json.git
  GIT_TAG 9cca280a4d0ccf0c08f47a99aa71d1b0e52f8d03
  GIT_SHALLOW FALSE)

# --- protocol contract tests (cross-platform, fake backend, no UIA) ---------
option(ADL_PROTOCOL_TESTS_ONLY
  "Build only the cross-platform protocol contract tests (Linux/macOS/Windows)." OFF)
if(ADL_PROTOCOL_TESTS_ONLY)
  enable_testing()
  FetchContent_MakeAvailable(nlohmann_json)
  add_executable(adl_protocol_tests
    tests/protocol_contract_tests.cpp
    src/protocol.cpp)
  target_include_directories(adl_protocol_tests PRIVATE src)
  target_link_libraries(adl_protocol_tests PRIVATE nlohmann_json::nlohmann_json)
  if(WIN32)
    target_link_libraries(adl_protocol_tests PRIVATE bcrypt)
    add_executable(adl_focus_identity_tests tests/focus_identity_tests.cpp)
    target_include_directories(adl_focus_identity_tests PRIVATE src)
    target_compile_definitions(adl_focus_identity_tests PRIVATE WIN32_LEAN_AND_MEAN NOMINMAX)
    target_link_libraries(adl_focus_identity_tests PRIVATE oleaut32)
    add_test(NAME focus_identity_contract COMMAND adl_focus_identity_tests)
    set_tests_properties(focus_identity_contract PROPERTIES TIMEOUT 10)
  endif()
  target_compile_definitions(adl_protocol_tests PRIVATE
    WIN32_LEAN_AND_MEAN NOMINMAX _CRT_SECURE_NO_WARNINGS)
  add_test(NAME protocol_contract COMMAND adl_protocol_tests)
  set_tests_properties(protocol_contract PROPERTIES TIMEOUT 30)
  return()
endif()

# --- toolchain guard --------------------------------------------------------
if(NOT WIN32)
  # Configure stays usable (docs, examples, CI lint); the compile below fails
  # with a clear message because the helper needs the Windows SDK.
  message(WARNING
    "Not Windows: adl-windows-uia-helper can only be compiled for Windows with MSVC "
    "and the Windows SDK. Building the guard target shows the compile-time error.")
  add_library(adl_uia_guard OBJECT src/main.cpp)
  target_compile_definitions(adl_uia_guard PRIVATE _WIN32=0)
  return()
endif()

if(NOT MSVC)
  message(FATAL_ERROR
    "This helper must be built with MSVC (for example: cmake -G \"Visual Studio 17 2022\" "
    "or the VS developer prompt with -G Ninja). Compiler in use: ${CMAKE_CXX_COMPILER_ID}.")
endif()
if(NOT CMAKE_VS_WINDOWS_TARGET_PLATFORM_VERSION)
  message(FATAL_ERROR
    "The Windows SDK was not found. Install the Windows 10/11 SDK component in VS Build Tools.")
endif()
message(STATUS "Windows SDK ${CMAKE_VS_WINDOWS_TARGET_PLATFORM_VERSION}, MSVC ${MSVC_VERSION}")

FetchContent_MakeAvailable(nlohmann_json)

add_executable(adl-windows-uia-helper
  src/main.cpp
  src/protocol.cpp
  src/uia_backend.cpp
  src/window_capture.cpp)
target_include_directories(adl-windows-uia-helper PRIVATE src)
target_link_libraries(adl-windows-uia-helper PRIVATE nlohmann_json::nlohmann_json
  ole32 oleaut32 uuid user32 gdi32 psapi uiautomationcore bcrypt
  d3d11 dxgi dwmapi windowscodecs windowsapp advapi32)
target_compile_definitions(adl-windows-uia-helper PRIVATE
  UNICODE _UNICODE WIN32_LEAN_AND_MEAN NOMINMAX _CRT_SECURE_NO_WARNINGS)
target_compile_options(adl-windows-uia-helper PRIVATE /W4 /permissive- /EHsc /utf-8 /guard:cf)

# Encoder tests run without a desktop; WGC's optional --interactive fixture is
# deliberately separate and must run in the user's synthetic test session.
enable_testing()
add_executable(adl_window_capture_tests tests/window_capture_tests.cpp src/window_capture.cpp)
target_include_directories(adl_window_capture_tests PRIVATE src)
target_compile_definitions(adl_window_capture_tests PRIVATE UNICODE _UNICODE WIN32_LEAN_AND_MEAN NOMINMAX)
target_link_libraries(adl_window_capture_tests PRIVATE nlohmann_json::nlohmann_json
  ole32 user32 d3d11 dxgi dwmapi windowscodecs windowsapp crypt32)
add_executable(adl_input_recovery_tests tests/input_recovery_tests.cpp)
target_include_directories(adl_input_recovery_tests PRIVATE src)
target_compile_definitions(adl_input_recovery_tests PRIVATE UNICODE _UNICODE WIN32_LEAN_AND_MEAN NOMINMAX)
target_link_libraries(adl_input_recovery_tests PRIVATE user32 bcrypt advapi32)
add_test(NAME input_ownership_contract COMMAND adl_input_recovery_tests)
set_tests_properties(input_ownership_contract PROPERTIES TIMEOUT 10)

add_test(NAME window_capture_encoder_contract COMMAND adl_window_capture_tests)
set_tests_properties(window_capture_encoder_contract PROPERTIES TIMEOUT 10)

if(NOT CMAKE_BUILD_TYPE)
  set(CMAKE_BUILD_TYPE Release CACHE STRING "" FORCE)
endif()
set_target_properties(adl-windows-uia-helper PROPERTIES OUTPUT_NAME "adl-windows-uia-helper")
set_property(TARGET adl-windows-uia-helper PROPERTY
  MSVC_RUNTIME_LIBRARY "MultiThreaded$<$<CONFIG:Debug>:Debug>")
