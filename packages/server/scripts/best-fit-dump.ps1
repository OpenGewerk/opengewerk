# What Windows makes of each character when it turns a name into a code page
# by best fit, as an unpacker does that creates names through the ANSI
# functions (opengewerk#920, opengewerk#922). Runs on Windows in PowerShell 7:
#
#   pwsh packages/server/scripts/best-fit-dump.ps1 <dump.json>
#   node packages/server/scripts/best-fit-table.js <dump.json>
#
# The second step writes src/privacy/best-fit.ts from the dump.
#
# Each character goes in behind an "X", once without flags and once with
# WC_COMPOSITECHECK | WC_DISCARDNS (528), which drops marks. The dump keeps
# what the character becomes where that is not the character itself, "" where
# it is dropped, and leaves out what a code page cannot map at all (it uses its
# default character, and a name with it fails there anyway).

param([Parameter(Mandatory = $true)][string] $Out)

$source = @'
using System;
using System.Runtime.InteropServices;
using System.Text;

public static class BestFitDump {
  [DllImport("kernel32.dll", SetLastError = true)]
  static extern int WideCharToMultiByte(uint codePage, uint flags, [MarshalAs(UnmanagedType.LPWStr)] string wide, int wideLength, byte[] multi, int multiLength, IntPtr defaultChar, out int usedDefault);

  [DllImport("kernel32.dll", CharSet = CharSet.Unicode)]
  static extern int MultiByteToWideChar(uint codePage, uint flags, byte[] multi, int multiLength, [Out] char[] wide, int wideLength);

  static string Escape(string text) {
    var escaped = new StringBuilder();
    foreach (char unit in text) escaped.Append("\\u" + ((int)unit).ToString("x4"));
    return escaped.ToString();
  }

  public static string Run(uint[] pages, uint flags) {
    var json = new StringBuilder("{");
    var bytes = new byte[32];
    var wide = new char[32];
    bool firstPage = true;
    foreach (var page in pages) {
      if (!firstPage) json.Append(",");
      firstPage = false;
      json.Append("\"" + page + "\":{");
      bool first = true;
      for (int code = 0x80; code <= 0x10FFFF; code++) {
        if (code >= 0xD800 && code <= 0xDFFF) continue;
        string character = char.ConvertFromUtf32(code);
        string text = "X" + character;
        int usedDefault;
        int length = WideCharToMultiByte(page, flags, text, text.Length, bytes, bytes.Length, IntPtr.Zero, out usedDefault);
        if (length <= 0 || usedDefault != 0) continue;
        int back = MultiByteToWideChar(page, 0, bytes, length, wide, wide.Length);
        string made = new string(wide, 0, back);
        if (!made.StartsWith("X")) continue;
        made = made.Substring(1);
        if (made == character) continue;
        if (!first) json.Append(",");
        first = false;
        json.Append("\"" + code + "\":\"" + Escape(made) + "\"");
      }
      json.Append("}");
    }
    json.Append("}");
    return json.ToString();
  }
}
'@
Add-Type -TypeDefinition $source

# The ANSI and OEM code pages of Windows; best-fit-table.js keeps this order.
$pages = [uint32[]]@(437, 708, 720, 737, 775, 850, 852, 855, 857, 858, 860, 861, 862, 863, 864, 865, 866, 869, 874, 932, 936, 949, 950, 1250, 1251, 1252, 1253, 1254, 1255, 1256, 1257, 1258)
$json = '{"pages":[' + ($pages -join ',') + '],"0":' + [BestFitDump]::Run($pages, 0) + ',"528":' + [BestFitDump]::Run($pages, 0x210) + '}'
[System.IO.File]::WriteAllText($Out, $json, [System.Text.UTF8Encoding]::new($false))
