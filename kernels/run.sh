#!/bin/sh
# Boots a kernel in QEMU, with COM1 on this terminal. Usage: kernels/run.sh <kernel.elf> [command line]
# Exit status: (code << 1) | 1 for a code written to port 0xF4, and 0 after a triple fault.
KERNEL="$1"
ARGS="$2"
# lesson:qemu
exec qemu-system-x86_64 -machine q35 -accel tcg -m 64M \
  -kernel "$KERNEL" -append "$ARGS" \
  -serial stdio -display none \
  -no-reboot \
  -device isa-debug-exit,iobase=0xf4,iosize=1
# end lesson:qemu
