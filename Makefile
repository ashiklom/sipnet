CC=gcc
LD=gcc
AR=ar -rs
CFLAGS=-Wall -Werror -g -Isrc -Wno-c2x-extensions -DGIT_HASH='$(GIT_HASH)'
LIBLINKS=-lm
LIB_DIR=./libs
LDFLAGS=-L$(LIB_DIR)

# Main executables
COMMON_CFILES:=context.c logging.c modelParams.c util.c
COMMON_CFILES:=$(addprefix src/common/, $(COMMON_CFILES))
COMMON_OFILES=$(COMMON_CFILES:.c=.o)

SIPNET_CFILES:=sipnet.c cli.c events.c frontend.c outputItems.c runmean.c state.c
SIPNET_CFILES:=$(addprefix src/sipnet/, $(SIPNET_CFILES))
SIPNET_OFILES=$(SIPNET_CFILES:.c=.o)
SIPNET_LIBS=-lsipnet_common

CFILES=$(sort $(SIPNET_CFILES))

SIPNET_LIB=$(LIB_DIR)/libsipnet.a
COMMON_LIB=$(LIB_DIR)/libsipnet_common.a

# Doxygen
DOXYFILE = docs/Doxyfile
DOXYGEN_HTML_DIR = docs/api
DOXYGEN_LATEX_DIR = docs/latex

# the make command, with no arguments, should not build everything in this complex
# environment
.DEFAULT_GOAL := sipnet

# Look up what Git revision we're building from
# We use this below to compile the hash into the binary for ease of debugging
GIT_HASH := $(shell git rev-parse --short=10 HEAD; git diff-index --quiet HEAD || echo " plus uncommitted changes")

# all does everything build related (but not test)
all: sipnet document

# Build documentation with both Doxygen and Mkdocs
document: .doxygen.stamp .mkdocs.stamp

# Only update docs if source files or Doxyfile have changed
.doxygen.stamp: $(DOXYFILE) $(CFILES)
	@if [ ! -d $(DOXYGEN_HTML_DIR) ] || [ $(DOXYFILE) -nt .doxygen.stamp ] || \
	   find $(CFILES) -newer .doxygen.stamp | read dummy; then \
		echo "Running Doxygen..."; \
		doxygen $(DOXYFILE); \
		touch .doxygen.stamp; \
	else \
		echo "Doxygen is up-to-date."; \
	fi

.mkdocs.stamp: .doxygen.stamp
	@echo "Running Mkdocs to build site..."
	mkdocs build
	@touch .mkdocs.stamp

$(COMMON_LIB): $(COMMON_OFILES)
	$(AR) $(COMMON_LIB) $(COMMON_OFILES)

$(SIPNET_LIB): $(SIPNET_OFILES)
	$(AR) $(SIPNET_LIB) $(SIPNET_OFILES)

GCC_VERSION = $(shell $(CC) --version)
info:
	@echo "System info"
	@echo "ARCH: $(shell arch)"
	@echo "CC: $(GCC_VERSION)"
	@echo ""

sipnet: info $(SIPNET_OFILES) $(COMMON_LIB)
	$(LD) $(LDFLAGS) -o sipnet $(SIPNET_OFILES) $(LIBLINKS) $(SIPNET_LIBS)

# WEBASSEMBLY BUILD
# Requires the Emscripten SDK (emcc on PATH); see docs/web-assembly.md
EMCC ?= emcc
WASM_DIR ?= web
WASM_CFLAGS=-O3 -Wall -Werror -Isrc -Wno-c2x-extensions -DGIT_HASH='$(GIT_HASH)'
# MODULARIZE + EXPORT_ES6: emit an ES module exporting a factory, createSipnet()
# INVOKE_RUN=0: don't run main() on load; callers use callMain() instead
# EXIT_RUNTIME=1: honour exit() calls (SIPNET exits on bad input)
WASM_LDFLAGS=-lm -sMODULARIZE=1 -sEXPORT_ES6=1 -sEXPORT_NAME=createSipnet \
	-sINVOKE_RUN=0 -sEXIT_RUNTIME=1 -sALLOW_MEMORY_GROWTH=1 \
	-sENVIRONMENT=web,worker,node -sFORCE_FILESYSTEM=1 \
	-sEXPORTED_RUNTIME_METHODS=callMain,FS
WASM_JS=$(WASM_DIR)/sipnet.mjs

wasm: $(WASM_JS)

$(WASM_JS): $(COMMON_CFILES) $(SIPNET_CFILES) $(wildcard src/common/*.h src/sipnet/*.h)
	@mkdir -p $(WASM_DIR)
	$(EMCC) $(WASM_CFLAGS) $(COMMON_CFILES) $(SIPNET_CFILES) $(WASM_LDFLAGS) -o $@

wasm-clean:
	rm -f $(WASM_DIR)/sipnet.mjs $(WASM_DIR)/sipnet.wasm
	rm -rf $(WASM_DIR)/examples $(WASM_DIR)/param-info.json $(WASM_DIR)/output-info.json

# Static web runner (web/): wasm build + example inputs + docs metadata
WASM_EXAMPLES=niwot russell_1 russell_2 russell_3 russell_4
WASM_PORT ?= 8000

wasm-site: wasm
	@for ex in $(WASM_EXAMPLES); do \
		mkdir -p $(WASM_DIR)/examples/$$ex; \
		for f in sipnet.in sipnet.param sipnet.clim events.in; do \
			cp tests/smoke/$$ex/$$f $(WASM_DIR)/examples/$$ex/; \
		done; \
	done
	@echo "Copied example inputs to $(WASM_DIR)/examples/"
	node web/scripts/build-metadata.mjs

wasm-serve: wasm-site
	@echo "Serving $(WASM_DIR)/ at http://localhost:$(WASM_PORT)/ (Ctrl-C to stop)"
	python3 -m http.server --directory $(WASM_DIR) $(WASM_PORT)

# Run the smoke tests through the wasm build (needs node)
wasm-smoke: wasm
	node tests/wasm/run_smoke_wasm.mjs $(WASM_DIR)

# Benchmark native vs. wasm on the smoke-test configurations (needs node)
wasm-bench: wasm sipnet
	node tests/wasm/bench.mjs --markdown

clean:
	rm -f $(SIPNET_OFILES) $(COMMON_OFILES)
	rm -f $(COMMON_LIB) $(SIPNET_LIB)
	rm -f sipnet
	rm -rf $(DOXYGEN_HTML_DIR) $(DOXYGEN_LATEX_DIR)
	rm -rf site/
	rm -f .doxygen.stamp .mkdocs.stamp

# UNIT TESTS
SIPNET_TEST_DIRS:=$(shell find tests/sipnet -mindepth 1 -maxdepth 1 -type d)
SIPNET_TEST_DIRS_RUN:= $(addsuffix .run, $(SIPNET_TEST_DIRS))
SIPNET_TEST_DIRS_CLEAN:= $(addsuffix .clean, $(SIPNET_TEST_DIRS))

# Build unit test executables (does not run them)
testbuild: $(SIPNET_TEST_DIRS) $(COMMON_LIB) $(SIPNET_LIB)

# The dash in the build command tells make to continue if there are errors, allowing cleanup
$(SIPNET_TEST_DIRS): $(SIPNET_LIB) $(COMMON_LIB)
	-$(MAKE) -C $@

testrun: $(SIPNET_TEST_DIRS_RUN)

$(SIPNET_TEST_DIRS_RUN):
	$(MAKE) -C $(basename $@) run

testclean: $(SIPNET_TEST_DIRS_CLEAN)
#	rm -f $(SIPNET_LIB)

$(SIPNET_TEST_DIRS_CLEAN):
	$(MAKE) -C $(basename $@) clean

cleanall: clean testclean

.PHONY: all clean help document exec cleanall \
		test testbuild $(SIPNET_TEST_DIRS) $(SIPNET_TEST_DIRS_RUN) testclean $(SIPNET_TEST_DIRS_CLEAN) testrun smoke unit \
		wasm wasm-clean wasm-smoke wasm-bench wasm-site wasm-serve

help:
	@echo "Available make targets:"
	@echo "  help         - Display this help message."
	@echo "  === Core Targets ==="
	@echo "  sipnet       - (also default target) Build the sipnet executable; see sipnet.in in the src/sipnet"
	@echo "                 directory for a sample input file"
	@echo "  document     - Generate documentation (via doxygen and mkdocs)"
	@echo "  all          - Build sipnet executable and the documentation"
	@echo "  clean        - Remove compiled files, executables, and documentation"
	@echo "  depend       - Generate build dependency information for source files and append to Makefile"
	@echo "  === WebAssembly (requires emcc; see docs/web-assembly.md) ==="
	@echo "  wasm         - Build web/sipnet.mjs + web/sipnet.wasm with Emscripten"
	@echo "  wasm-site    - Build wasm and assemble the static web runner in web/"
	@echo "  wasm-serve   - Build the web runner and serve it at http://localhost:8000/"
	@echo "  wasm-clean   - Remove the WebAssembly build outputs"
	@echo "  wasm-smoke   - Run the smoke tests against the WebAssembly build (needs node)"
	@echo "  wasm-bench   - Benchmark native vs. WebAssembly builds (needs node)"
	@echo "  === Tests ==="
	@echo "  test         - Build + run unit tests, then smoke tests"
	@echo "  testbuild    - Build the unit tests (does not run)"
	@echo "  testrun      - Run the unit tests (per-directory runners)"
	@echo "  unit         - Build and run unit tests (wrapper with summary)"
	@echo "  smoke        - Run smoke tests (end-to-end diffs)"
	@echo "  testclean    - Clean build artifacts and executables from the unit tests"
	@echo "  cleanall     - Run both clean and testclean"

# Convenience test targets
unit: sipnet testbuild
	./tools/run_unit_tests.sh

smoke: sipnet
	./tests/smoke/run_smoke.sh

# Combined verification target
test: sipnet testbuild
	./tools/run_unit_tests.sh && ./tests/smoke/run_smoke.sh

# Make sure this target and subsequent comment remain at the bottom of this file
depend::
	makedepend $(CFILES)

# DO NOT DELETE THIS LINE -- make depend depends on it.
