/** GENERATED from scratch C files by gen.py: real compiler output, Apple clang 21.0.0 (clang-2100.1.1.101), x86-64 Linux target,
 * assembler directives and comments removed. Do not edit by hand. */
/** The C and C++ files, exactly as compiled. */
export const GOLDEN_SOURCES: Record<string, readonly string[]> = {
 "alias.c": [
  "int f(int *i, float *f) {",
  "    *i = 1;",
  "    *f = 2.0f;",
  "    return *i;",
  "}",
  "int g(int *a, int *b) {",
  "    *a = 1;",
  "    *b = 2;",
  "    return *a;",
  "}",
  "int h(int *restrict a, int *restrict b) {",
  "    *a = 1;",
  "    *b = 2;",
  "    return *a;",
  "}"
 ],
 "chk2.c": [
  "void *malloc(unsigned long size);",
  "int add_bad(int a, int b) {",
  "    if (b > 0 && a + b < a)",
  "        return -1;",
  "    return a + b;",
  "}",
  "int add_pre(int a, int b) {",
  "    if (b > 0 && a > 2147483647 - b)",
  "        return -1;",
  "    return a + b;",
  "}",
  "int add_builtin(int a, int b) {",
  "    int r;",
  "    if (__builtin_add_overflow(a, b, &r))",
  "        return -1;",
  "    return r;",
  "}",
  "int add_unsigned(int a, int b) {",
  "    int r = (int)((unsigned)a + (unsigned)b);",
  "    if (b > 0 && r < a)",
  "        return -1;",
  "    return r;",
  "}",
  "void *alloc_array(unsigned n, unsigned size) {",
  "    unsigned bytes = n * size;",
  "    return malloc(bytes);",
  "}",
  "void *alloc_array_ok(unsigned long n, unsigned long size) {",
  "    unsigned long bytes;",
  "    if (__builtin_mul_overflow(n, size, &bytes))",
  "        return 0;",
  "    return malloc(bytes);",
  "}"
 ],
 "fermat.c": [
  "int fermat() {",
  "    const int MAX = 1000;",
  "    int a = 1, b = 1, c = 1;",
  "    while (1) {",
  "        if (((a * a * a) == ((b * b * b) + (c * c * c)))) return 1;",
  "        a++;",
  "        if (a > MAX) { a = 1; b++; }",
  "        if (b > MAX) { b = 1; c++; }",
  "        if (c > MAX) { c = 1; }",
  "    }",
  "    return 0;",
  "}",
  "void spin(void) { while (1) { } }",
  "void spin_n(unsigned n) { for (unsigned i = 0; i != n; i += 2) { } }"
 ],
 "fermat.cpp": [
  "int fermat() {",
  "    const int MAX = 1000;",
  "    int a = 1, b = 1, c = 1;",
  "    while (1) {",
  "        if (((a * a * a) == ((b * b * b) + (c * c * c)))) return 1;",
  "        a++;",
  "        if (a > MAX) { a = 1; b++; }",
  "        if (b > MAX) { b = 1; c++; }",
  "        if (c > MAX) { c = 1; }",
  "    }",
  "    return 0;",
  "}",
  "void spin() { while (1) { } }",
  "void spin_n(unsigned n) { for (unsigned i = 0; i != n; i += 2) { } }"
 ],
 "inc.c": [
  "int gt(int x) { return x + 1 > x; }",
  "int gtu(unsigned x) { return x + 1 > x; }"
 ],
 "loop.c": [
  "void fill(float *a, int n, int k) {",
  "    for (int i = 0; i < n; i++)",
  "        a[i + k] = 0.0f;",
  "}",
  "void fillu(float *a, unsigned n, unsigned k) {",
  "    for (unsigned i = 0; i < n; i++)",
  "        a[i + k] = 0.0f;",
  "}"
 ],
 "null.c": [
  "#include <stddef.h>",
  "int get(int *p) {",
  "    int x = *p;",
  "    if (p == NULL)",
  "        return -1;",
  "    return x;",
  "}"
 ],
 "pun2.c": [
  "unsigned bits_memcpy(float f) { unsigned u; __builtin_memcpy(&u, &f, sizeof u); return u; }",
  "unsigned bits_union(float f) { union { float f; unsigned u; } x = { .f = f }; return x.u; }",
  "unsigned bits_cast(float f) { return *(unsigned *)&f; }"
 ],
 "scale.c": [
  "void scale(int *a, const int *k, int n) {",
  "    for (int i = 0; i < n; i++)",
  "        a[i] = a[i] * *k;",
  "}",
  "void scale_r(int *restrict a, const int *k, int n) {",
  "    for (int i = 0; i < n; i++)",
  "        a[i] = a[i] * *k;",
  "}",
  "void scale_f(float *a, const int *k, int n) {",
  "    for (int i = 0; i < n; i++)",
  "        a[i] = a[i] * *k;",
  "}"
 ]
};

export const GOLDEN = {
 "null.O2": {
  "cmd": "clang -O2 -target x86_64-linux-gnu -S -masm=intel null.c",
  "asm": [
   "get:",
   "  mov      eax, dword ptr [rdi]",
   "  ret"
  ]
 },
 "null.O2.nodelete": {
  "cmd": "clang -O2 -fno-delete-null-pointer-checks -target x86_64-linux-gnu -S -masm=intel null.c",
  "asm": [
   "get:",
   "  test     rdi, rdi",
   "  je       .LBB0_1",
   "  mov      eax, dword ptr [rdi]",
   "  ret",
   ".LBB0_1:",
   "  mov      eax, -1",
   "  ret"
  ]
 },
 "gt.O2": {
  "cmd": "clang -O2 -target x86_64-linux-gnu -S -masm=intel inc.c",
  "asm": [
   "gt:",
   "  mov      eax, 1",
   "  ret"
  ]
 },
 "gt.O2.fwrapv": {
  "cmd": "clang -O2 -fwrapv -target x86_64-linux-gnu -S -masm=intel inc.c",
  "asm": [
   "gt:",
   "  xor      eax, eax",
   "  cmp      edi, 2147483647",
   "  setne    al",
   "  ret"
  ]
 },
 "gtu.O2": {
  "cmd": "clang -O2 -target x86_64-linux-gnu -S -masm=intel inc.c",
  "asm": [
   "gtu:",
   "  xor      eax, eax",
   "  cmp      edi, -1",
   "  setne    al",
   "  ret"
  ]
 },
 "fermat.cpp17": {
  "cmd": "clang -x c++ -std=c++17 -O2 -target x86_64-linux-gnu -S -masm=intel fermat.cpp",
  "asm": [
   "_Z6fermatv:",
   "  mov      eax, 1",
   "  ret"
  ]
 },
 "fermat.c11": {
  "cmd": "clang -std=c11 -O2 -target x86_64-linux-gnu -S -masm=intel fermat.c",
  "asm": [
   "fermat:",
   "  mov      eax, 1",
   "  mov      esi, 1",
   "  mov      edi, 1",
   "  mov      edx, 1",
   ".LBB0_1:",
   "  xor      ecx, ecx",
   "  cmp      edx, 1000",
   "  lea      edx, [rdx + 1]",
   "  setge    cl",
   "  cmovge   edx, eax",
   "  add      ecx, edi",
   "  xor      edi, edi",
   "  cmp      ecx, 1001",
   "  setge    dil",
   "  cmovge   ecx, eax",
   "  add      edi, esi",
   "  cmp      edi, 1001",
   "  cmovge   edi, eax",
   "  mov      r8d, edx",
   "  imul     r8d, edx",
   "  imul     r8d, edx",
   "  mov      esi, ecx",
   "  imul     esi, ecx",
   "  imul     esi, ecx",
   "  mov      r9d, edi",
   "  imul     r9d, edi",
   "  imul     r9d, edi",
   "  add      r9d, esi",
   "  mov      esi, edi",
   "  mov      edi, ecx",
   "  cmp      r8d, r9d",
   "  jne      .LBB0_1",
   "  mov      eax, 1",
   "  ret"
  ]
 },
 "spin.cpp17": {
  "cmd": "clang -x c++ -std=c++17 -O2 -target x86_64-linux-gnu -S -masm=intel fermat.cpp",
  "asm": [
   "_Z4spinv:",
   ".LBB1_1:",
   "  jmp      .LBB1_1"
  ]
 },
 "spin_n.cpp17": {
  "cmd": "clang -x c++ -std=c++17 -O2 -target x86_64-linux-gnu -S -masm=intel fermat.cpp",
  "asm": [
   "_Z6spin_nj:",
   "  ret"
  ]
 },
 "tbaa.O2": {
  "cmd": "clang -O2 -target x86_64-linux-gnu -S -masm=intel alias.c",
  "asm": [
   "f:",
   "  mov      dword ptr [rdi], 1",
   "  mov      dword ptr [rsi], 1073741824",
   "  mov      eax, 1",
   "  ret"
  ]
 },
 "tbaa.O2.nostrict": {
  "cmd": "clang -O2 -fno-strict-aliasing -target x86_64-linux-gnu -S -masm=intel alias.c",
  "asm": [
   "f:",
   "  mov      dword ptr [rdi], 1",
   "  mov      dword ptr [rsi], 1073741824",
   "  mov      eax, dword ptr [rdi]",
   "  ret"
  ]
 },
 "same.O2": {
  "cmd": "clang -O2 -target x86_64-linux-gnu -S -masm=intel alias.c",
  "asm": [
   "g:",
   "  mov      dword ptr [rdi], 1",
   "  mov      dword ptr [rsi], 2",
   "  mov      eax, dword ptr [rdi]",
   "  ret"
  ]
 },
 "restrict.O2": {
  "cmd": "clang -O2 -target x86_64-linux-gnu -S -masm=intel alias.c",
  "asm": [
   "h:",
   "  mov      dword ptr [rdi], 1",
   "  mov      dword ptr [rsi], 2",
   "  mov      eax, 1",
   "  ret"
  ]
 },
 "scale.O2": {
  "cmd": "clang -O2 -fno-vectorize -fno-slp-vectorize -fno-unroll-loops -target x86_64-linux-gnu -S -masm=intel scale.c",
  "asm": [
   "scale:",
   "  test     edx, edx",
   "  jle      .LBB0_3",
   "  mov      eax, edx",
   "  xor      ecx, ecx",
   ".LBB0_2:",
   "  mov      edx, dword ptr [rsi]",
   "  imul     edx, dword ptr [rdi + 4*rcx]",
   "  mov      dword ptr [rdi + 4*rcx], edx",
   "  inc      rcx",
   "  cmp      rax, rcx",
   "  jne      .LBB0_2",
   ".LBB0_3:",
   "  ret"
  ]
 },
 "scale_r.O2": {
  "cmd": "clang -O2 -fno-vectorize -fno-slp-vectorize -fno-unroll-loops -target x86_64-linux-gnu -S -masm=intel scale.c",
  "asm": [
   "scale_r:",
   "  test     edx, edx",
   "  jle      .LBB1_3",
   "  mov      eax, dword ptr [rsi]",
   "  mov      ecx, edx",
   "  xor      edx, edx",
   ".LBB1_2:",
   "  mov      esi, dword ptr [rdi + 4*rdx]",
   "  imul     esi, eax",
   "  mov      dword ptr [rdi + 4*rdx], esi",
   "  inc      rdx",
   "  cmp      rcx, rdx",
   "  jne      .LBB1_2",
   ".LBB1_3:",
   "  ret"
  ]
 },
 "scale_f.O2": {
  "cmd": "clang -O2 -fno-vectorize -fno-slp-vectorize -fno-unroll-loops -target x86_64-linux-gnu -S -masm=intel scale.c",
  "asm": [
   "scale_f:",
   "  test     edx, edx",
   "  jle      .LBB2_3",
   "  cvtsi2ss xmm0, dword ptr [rsi]",
   "  mov      eax, edx",
   "  xor      ecx, ecx",
   ".LBB2_2:",
   "  movss    xmm1, dword ptr [rdi + 4*rcx]",
   "  mulss    xmm1, xmm0",
   "  movss    dword ptr [rdi + 4*rcx], xmm1",
   "  inc      rcx",
   "  cmp      rax, rcx",
   "  jne      .LBB2_2",
   ".LBB2_3:",
   "  ret"
  ]
 },
 "scale_f.O2.nostrict": {
  "cmd": "clang -O2 -fno-vectorize -fno-slp-vectorize -fno-unroll-loops -fno-strict-aliasing -target x86_64-linux-gnu -S -masm=intel scale.c",
  "asm": [
   "scale_f:",
   "  test     edx, edx",
   "  jle      .LBB2_3",
   "  mov      eax, edx",
   "  xor      ecx, ecx",
   ".LBB2_2:",
   "  xorps    xmm0, xmm0",
   "  cvtsi2ss xmm0, dword ptr [rsi]",
   "  mulss    xmm0, dword ptr [rdi + 4*rcx]",
   "  movss    dword ptr [rdi + 4*rcx], xmm0",
   "  inc      rcx",
   "  cmp      rax, rcx",
   "  jne      .LBB2_2",
   ".LBB2_3:",
   "  ret"
  ]
 },
 "fill.O2": {
  "cmd": "clang -O2 -fno-vectorize -fno-unroll-loops -target x86_64-linux-gnu -S -masm=intel loop.c",
  "asm": [
   "fill:",
   "  test     esi, esi",
   "  jle      .LBB0_1",
   "  movsxd   rax, edx",
   "  lea      rdi, [rdi + 4*rax]",
   "  mov      edx, esi",
   "  shl      rdx, 2",
   "  xor      esi, esi",
   "  jmp      memset@PLT",
   ".LBB0_1:",
   "  ret"
  ]
 },
 "fillu.O2": {
  "cmd": "clang -O2 -fno-vectorize -fno-unroll-loops -target x86_64-linux-gnu -S -masm=intel loop.c",
  "asm": [
   "fillu:",
   "  test     esi, esi",
   "  je       .LBB1_3",
   "  mov      eax, esi",
   ".LBB1_2:",
   "  mov      ecx, edx",
   "  mov      dword ptr [rdi + 4*rcx], 0",
   "  inc      edx",
   "  dec      rax",
   "  jne      .LBB1_2",
   ".LBB1_3:",
   "  ret"
  ]
 },
 "add_bad.O2": {
  "cmd": "clang -O2 -target x86_64-linux-gnu -S -masm=intel chk2.c",
  "asm": [
   "add_bad:",
   "  lea      eax, [rdi + rsi]",
   "  ret"
  ]
 },
 "add_bad.O2.fwrapv": {
  "cmd": "clang -O2 -fwrapv -target x86_64-linux-gnu -S -masm=intel chk2.c",
  "asm": [
   "add_bad:",
   "  lea      ecx, [rsi + rdi]",
   "  cmp      ecx, edi",
   "  mov      eax, -1",
   "  cmovge   eax, ecx",
   "  test     esi, esi",
   "  cmovle   eax, ecx",
   "  ret"
  ]
 },
 "add_pre.O2": {
  "cmd": "clang -O2 -target x86_64-linux-gnu -S -masm=intel chk2.c",
  "asm": [
   "add_pre:",
   "  mov      eax, esi",
   "  xor      eax, 2147483647",
   "  lea      ecx, [rsi + rdi]",
   "  cmp      edi, eax",
   "  mov      eax, -1",
   "  cmovle   eax, ecx",
   "  test     esi, esi",
   "  cmovle   eax, ecx",
   "  ret"
  ]
 },
 "add_builtin.O2": {
  "cmd": "clang -O2 -target x86_64-linux-gnu -S -masm=intel chk2.c",
  "asm": [
   "add_builtin:",
   "  add      edi, esi",
   "  mov      eax, -1",
   "  cmovno   eax, edi",
   "  ret"
  ]
 },
 "add_unsigned.O2": {
  "cmd": "clang -O2 -target x86_64-linux-gnu -S -masm=intel chk2.c",
  "asm": [
   "add_unsigned:",
   "  lea      ecx, [rsi + rdi]",
   "  cmp      ecx, edi",
   "  mov      eax, -1",
   "  cmovge   eax, ecx",
   "  test     esi, esi",
   "  cmovle   eax, ecx",
   "  ret"
  ]
 },
 "alloc_array.O2": {
  "cmd": "clang -O2 -target x86_64-linux-gnu -S -masm=intel chk2.c",
  "asm": [
   "alloc_array:",
   "  imul     edi, esi",
   "  jmp      malloc@PLT"
  ]
 },
 "alloc_array_ok.O2": {
  "cmd": "clang -O2 -target x86_64-linux-gnu -S -masm=intel chk2.c",
  "asm": [
   "alloc_array_ok:",
   "  mov      rax, rdi",
   "  mul      rsi",
   "  jno      .LBB5_2",
   "  xor      eax, eax",
   "  ret",
   ".LBB5_2:",
   "  mov      rdi, rax",
   "  jmp      malloc@PLT"
  ]
 },
 "bits_memcpy.O2": {
  "cmd": "clang -O2 -target x86_64-linux-gnu -S -masm=intel pun2.c",
  "asm": [
   "bits_memcpy:",
   "  movd     eax, xmm0",
   "  ret"
  ]
 },
 "bits_union.O2": {
  "cmd": "clang -O2 -target x86_64-linux-gnu -S -masm=intel pun2.c",
  "asm": [
   "bits_union:",
   "  movd     eax, xmm0",
   "  ret"
  ]
 },
 "bits_cast.O2": {
  "cmd": "clang -O2 -target x86_64-linux-gnu -S -masm=intel pun2.c",
  "asm": [
   "bits_cast:",
   "  movd     eax, xmm0",
   "  ret"
  ]
 }
} as const;
