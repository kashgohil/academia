//! The same boot stub as the Rust kernel, then one stage of its self-test: serial output and a heap
//! behind std.mem.Allocator. Run it with `pnpm test:kernels`.
const std = @import("std");
const Alignment = std.mem.Alignment;

// lesson:zig-start
// zig build-exe kernel.zig ../boot.s -target x86_64-freestanding-none \
//   -mcpu=x86_64-sse-sse2-mmx-avx+soft_float -mcmodel=kernel -mno-red-zone \
//   -fllvm -flld -O ReleaseSafe -T ../kernel.ld -fentry=boot32
pub const panic = std.debug.no_panic;

fn outb(port: u16, value: u8) void {
    asm volatile ("outb %[value], %[port]"
        : // no outputs
        : [value] "{al}" (value),
          [port] "{dx}" (port),
    );
}

fn print(text: []const u8) void {
    for (text) |c| outb(0x3F8, c);
}

// boot.s jumps here in 64-bit mode.
comptime {
    asm (
        \\    .text
        \\    .globl high_entry
        \\high_entry:
        \\    lea kernel_stack_top(%rip), %rsp
        \\    call kmain
        \\    ud2
        \\    .section .bss
        \\    .balign 16
        \\    .skip 65536
        \\kernel_stack_top:
    );
}
// end lesson:zig-start

const direct_map: usize = 0xFFFF_8000_0000_0000;
const kernel_vma: usize = 0xFFFF_FFFF_8000_0000;
const heap_base: usize = 0xFFFF_C000_0000_0000;
const page: usize = 4096;

extern const _kernel_end: u8;
var next_frame: usize = 0;

/// The simplest frame allocator: frames above the kernel are never returned. This test touches only a few.
fn allocFrame() usize {
    const pa = next_frame;
    next_frame += page;
    const bytes: [*]u8 = @ptrFromInt(direct_map + pa);
    @memset(bytes[0..page], 0);
    return pa;
}

fn readCr3() usize {
    return asm volatile ("mov %%cr3, %[v]"
        : [v] "=r" (-> usize),
    );
}

fn mapHeapPage(va: usize) bool {
    const present_writable: usize = 3;
    var table = readCr3() & ~@as(usize, 0xFFF);
    for ([_]u6{ 39, 30, 21 }) |shift| {
        const entries: [*]usize = @ptrFromInt(direct_map + table);
        const e = &entries[(va >> shift) & 511];
        if (e.* & 1 == 0) e.* = allocFrame() | present_writable;
        table = e.* & 0x000F_FFFF_FFFF_F000;
    }
    const entries: [*]usize = @ptrFromInt(direct_map + table);
    entries[(va >> 12) & 511] = allocFrame() | present_writable;
    return true;
}

// lesson:zig-bump
const Bump = struct {
    next: usize = 0,
    mapped: usize = 0,

    fn alloc(ctx: *anyopaque, len: usize, a: Alignment, ret: usize) ?[*]u8 {
        _ = ret;
        const self: *Bump = @ptrCast(@alignCast(ctx));
        const start = a.forward(self.next);
        const end = start + len;
        while (self.mapped < end) : (self.mapped += 4096) {
            if (!mapHeapPage(heap_base + self.mapped)) return null;
        }
        self.next = end;
        return @ptrFromInt(heap_base + start);
    }

    pub fn allocator(self: *Bump) std.mem.Allocator {
        return .{ .ptr = self, .vtable = &.{
            .alloc = alloc,
            .resize = std.mem.Allocator.noResize,
            .remap = std.mem.Allocator.noRemap,
            .free = std.mem.Allocator.noFree,
        } };
    }
};
// end lesson:zig-bump

fn exit(code: u8) noreturn {
    outb(0xF4, code);
    while (true) asm volatile ("cli; hlt");
}

export fn kmain(info: usize, magic: u32) noreturn {
    _ = info;
    _ = magic;
    print("zig: 64-bit mode\n");
    next_frame = std.mem.alignForward(usize, @intFromPtr(&_kernel_end) - kernel_vma, page);

    var bump = Bump{};
    const heap = bump.allocator();
    const values = heap.alloc(u64, 2000) catch exit(0x20);
    var sum: u64 = 0;
    for (values, 0..) |*v, i| {
        v.* = i;
        sum += v.*;
    }
    if (sum != 1_999_000) exit(0x20);
    if (bump.mapped != 16384) exit(0x20);
    print("zig: heap holds 2000 values in 4 mapped pages\n");
    print("all tests passed\n");
    exit(0x10);
}
