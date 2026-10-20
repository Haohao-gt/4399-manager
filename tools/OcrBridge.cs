// 4399 管理器 · 验证码 OCR 桥（32 位）
// 作用：在 32 位进程里加载用户自训练的 ocr.dll（64 位 Node 无法直接加载 32 位 DLL），
//       通过 stdin/stdout 的「base64 一行进、识别文本一行出」协议为 Node 提供识别能力。
// 协议：
//   启动成功后向 stdout 打印一行  READY
//   之后每读一行：base64(图片字节)  ->  输出一行：识别结果文本（失败为 ERR:xxx）
//   读到 QUIT 或 stdin 关闭则退出
// 日志一律走 stderr，不污染协议。
using System;
using System.IO;
using System.Runtime.InteropServices;
using System.Text;

internal static class OcrBridge
{
    [DllImport("kernel32", CharSet = CharSet.Unicode, SetLastError = true)]
    private static extern IntPtr LoadLibraryW(string lpFileName);

    [DllImport("kernel32", SetLastError = true, CharSet = CharSet.Ansi)]
    private static extern IntPtr GetProcAddress(IntPtr hModule, string lpProcName);

    [DllImport("kernel32", SetLastError = true)]
    private static extern bool FreeLibrary(IntPtr hModule);

    [UnmanagedFunctionPointer(CallingConvention.StdCall)]
    private delegate int InitDelegate();

    [UnmanagedFunctionPointer(CallingConvention.StdCall)]
    private delegate IntPtr OcrDelegate(IntPtr data, int len);

    [UnmanagedFunctionPointer(CallingConvention.StdCall)]
    private delegate void UnDelegate();

    private static void Log(string s)
    {
        try { Console.Error.WriteLine(s); Console.Error.Flush(); } catch { }
    }

    private static int Main(string[] args)
    {
        try { Console.OutputEncoding = new UTF8Encoding(false); } catch { }

        string dllPath = args.Length > 0 && args[0].Length > 0 ? args[0] : "ocr.dll";

        IntPtr h;
        try { h = LoadLibraryW(dllPath); }
        catch (Exception e) { Log("LoadLibraryW threw: " + e.Message); return 2; }
        if (h == IntPtr.Zero)
        {
            Log("LoadLibraryW failed err=" + Marshal.GetLastWin32Error() + " path=" + dllPath);
            return 2;
        }
        Log("loaded ocr.dll h=0x" + h.ToInt64().ToString("X"));

        IntPtr pInit = GetProcAddress(h, "init");
        IntPtr pOcr = GetProcAddress(h, "ocr");
        IntPtr pUn = GetProcAddress(h, "un");
        if (pOcr == IntPtr.Zero) { Log("GetProcAddress(ocr) failed"); return 3; }

        OcrDelegate ocr = (OcrDelegate)Marshal.GetDelegateForFunctionPointer(pOcr, typeof(OcrDelegate));
        InitDelegate init = null;
        UnDelegate un = null;
        if (pInit != IntPtr.Zero) init = (InitDelegate)Marshal.GetDelegateForFunctionPointer(pInit, typeof(InitDelegate));
        if (pUn != IntPtr.Zero) un = (UnDelegate)Marshal.GetDelegateForFunctionPointer(pUn, typeof(UnDelegate));

        if (init != null)
        {
            try { int r = init(); Log("init() -> " + r); }
            catch (Exception e) { Log("init threw: " + e.Message); return 4; }
        }

        Console.Out.WriteLine("READY");
        Console.Out.Flush();

        StreamReader reader = new StreamReader(Console.OpenStandardInput(), Encoding.ASCII);
        string line;
        while ((line = reader.ReadLine()) != null)
        {
            line = line.Trim();
            if (line.Length == 0) continue;
            if (line == "QUIT") break;

            string result;
            try
            {
                byte[] img = Convert.FromBase64String(line);
                IntPtr buf = Marshal.AllocHGlobal(img.Length);
                try
                {
                    Marshal.Copy(img, 0, buf, img.Length);
                    IntPtr p = ocr(buf, img.Length);
                    result = (p == IntPtr.Zero) ? "" : (Marshal.PtrToStringAnsi(p) ?? "");
                }
                finally { Marshal.FreeHGlobal(buf); }
            }
            catch (Exception e)
            {
                result = "ERR:" + e.Message;
            }
            Console.Out.WriteLine(result);
            Console.Out.Flush();
        }

        try { if (un != null) un(); } catch { }
        try { FreeLibrary(h); } catch { }
        return 0;
    }
}
