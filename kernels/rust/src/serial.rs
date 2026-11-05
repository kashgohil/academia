//! COM1, port access and the debug exit device.
use core::arch::asm;
use core::fmt::{self, Write};

const COM1: u16 = 0x3F8;

// lesson:outb
pub unsafe fn outb(port: u16, value: u8) {
    unsafe { asm!("out dx, al", in("dx") port, in("al") value, options(nomem, nostack, preserves_flags)) };
}

pub unsafe fn inb(port: u16) -> u8 {
    let value: u8;
    unsafe { asm!("in al, dx", in("dx") port, out("al") value, options(nomem, nostack, preserves_flags)) };
    value
}

pub fn init() {
    unsafe {
        outb(COM1 + 1, 0x00); // no UART interrupts
        outb(COM1 + 3, 0x80); // DLAB on: the next two registers are the divisor
        outb(COM1, 0x01); //     divisor 1 = 115200 baud
        outb(COM1 + 1, 0x00);
        outb(COM1 + 3, 0x03); // DLAB off, 8 data bits, no parity, 1 stop bit
        outb(COM1 + 2, 0xC7); // FIFOs on
    }
}

pub fn putc(b: u8) {
    unsafe {
        while inb(COM1 + 5) & 0x20 == 0 {} // wait until the transmitter can take a byte
        outb(COM1, b);
    }
}
// end lesson:outb

pub struct Serial;
impl Write for Serial {
    fn write_str(&mut self, s: &str) -> fmt::Result {
        s.bytes().for_each(putc);
        Ok(())
    }
}

#[macro_export]
macro_rules! println {
    ($($arg:tt)*) => {{
        use core::fmt::Write;
        let _irq = $crate::sched::IrqGuard::new();
        let _ = writeln!($crate::serial::Serial, $($arg)*);
    }};
}

/// QEMU's isa-debug-exit device: the process exits with status (code << 1) | 1.
pub fn qemu_exit(code: u8) -> ! {
    unsafe { outb(0xF4, code) };
    loop {
        unsafe { asm!("cli; hlt", options(nomem, nostack)) };
    }
}
