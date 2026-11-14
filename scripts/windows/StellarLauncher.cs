// Stellar Launcher — 单文件 Windows 启动器（零依赖，.NET Framework 4.8 自带）。
// 自带一份程序压缩包（内嵌资源 Stellar.payload.zip），双击即可：
//   1) 当前目录已经是程序目录 → 直接进菜单（首次检查 / 启动桥接 / 打开控制台）
//   2) 不是 → 问一个目标目录，解压出来，再跑「首次启动.bat」
// 设计约束：exe 只是引导器。DSH 桌面端、SnowLuma 2、QQ 号必须用户自己有，不打包也不代装。
using System;
using System.Diagnostics;
using System.IO;
using System.IO.Compression;
using System.Linq;
using System.Reflection;
using System.Text;

static class StellarLauncher
{
    const string Payload = "Stellar.payload.zip";

    static string ExeDir
    {
        get { return Path.GetDirectoryName(Assembly.GetExecutingAssembly().Location); }
    }

    static bool IsProgramDir(string dir)
    {
        return File.Exists(Path.Combine(dir, "src", "bridge.js"))
            && File.Exists(Path.Combine(dir, "package.json"));
    }

    static int Main(string[] args)
    {
        try { Console.OutputEncoding = Encoding.UTF8; } catch { }
        Console.Title = "Stellar";

        string mode = args.Length > 0 ? args[0].ToLowerInvariant() : "";

        if (mode == "--extract")
        {
            string target = args.Length > 1 ? args[1] : DefaultTarget();
            return Extract(target, false);
        }
        if (mode == "--check")
        {
            Console.WriteLine("exe:      " + Assembly.GetExecutingAssembly().Location);
            Console.WriteLine("目录:     " + ExeDir);
            Console.WriteLine("是程序目录: " + (IsProgramDir(ExeDir) ? "是" : "不是"));
            Console.WriteLine("自带压缩包: " + (HasPayload() ? "有" : "没有"));
            Console.WriteLine("默认解压到: " + DefaultTarget());
            return 0;
        }

        Console.WriteLine("============================================");
        Console.WriteLine("  Stellar 启动器");
        Console.WriteLine("============================================");
        Console.WriteLine();

        if (!IsProgramDir(ExeDir))
            return InstallFlow();

        return Menu();
    }

    static bool HasPayload()
    {
        return Assembly.GetExecutingAssembly().GetManifestResourceNames()
            .Any(n => n.EndsWith(Payload, StringComparison.OrdinalIgnoreCase));
    }

    static string DefaultTarget()
    {
        string home = Environment.GetFolderPath(Environment.SpecialFolder.UserProfile);
        if (string.IsNullOrEmpty(home)) home = ExeDir;
        return Path.Combine(home, "Stellar");
    }

    static int InstallFlow()
    {
        if (!HasPayload())
        {
            Console.WriteLine("[X] 这个 exe 里没有自带程序包，可能是被裁剪过的版本。");
            Console.WriteLine("    请从 GitHub Releases 重新下载完整的 Stellar-Setup.exe。");
            Pause();
            return 1;
        }

        Console.WriteLine("这个 exe 自带一份完整程序，第一次用要先解压到一个文件夹。");
        Console.WriteLine("解压后不需要管理员权限，也不会写注册表；删掉那个文件夹就是卸载。");
        Console.WriteLine();
        Console.Write("解压到哪里 [回车 = " + DefaultTarget() + "]: ");
        string input = Console.ReadLine();
        string target = string.IsNullOrWhiteSpace(input) ? DefaultTarget() : input.Trim().Trim('"');

        int rc = Extract(target, true);
        if (rc != 0) { Pause(); return rc; }

        Console.WriteLine();
        Console.Write("现在就做首次启动检查吗？[Y/n]: ");
        string ans = Console.ReadLine();
        if (!string.IsNullOrWhiteSpace(ans) && !ans.Trim().ToLowerInvariant().StartsWith("y"))
        {
            Console.WriteLine();
            Console.WriteLine("好，那你自己去那个文件夹双击「首次启动.bat」。");
            Pause();
            return 0;
        }

        return RunBat(target, "首次启动.bat");
    }

    static int Menu()
    {
        Console.WriteLine("程序目录：" + ExeDir);
        Console.WriteLine();
        while (true)
        {
            Console.WriteLine("[1] 首次启动检查（装依赖、生成配置、对齐 DSH 端口）");
            Console.WriteLine("[2] 启动 QQ 桥接（她会开始回消息）");
            Console.WriteLine("[3] 打开控制台（浏览器看状态，127.0.0.1:3300）");
            Console.WriteLine("[4] 再把程序解压一份到别的目录");
            Console.WriteLine("[Q] 退出");
            Console.WriteLine();
            Console.Write("选一个: ");
            string c = (Console.ReadLine() ?? "").Trim().ToLowerInvariant();
            Console.WriteLine();
            if (c == "1") { RunBat(ExeDir, "首次启动.bat"); Console.WriteLine(); }
            else if (c == "2") { RunBat(ExeDir, "start.bat"); Console.WriteLine(); }
            else if (c == "3") { RunBat(ExeDir, "启动控制台.bat"); Console.WriteLine(); }
            else if (c == "4")
            {
                Console.Write("解压到哪里 [回车 = " + DefaultTarget() + "]: ");
                string t = Console.ReadLine();
                Extract(string.IsNullOrWhiteSpace(t) ? DefaultTarget() : t.Trim().Trim('"'), true);
                Console.WriteLine();
            }
            else if (c == "q" || c == "quit" || c == "exit") return 0;
            else Console.WriteLine("没这个选项。");
            Console.WriteLine();
        }
    }

    static int RunBat(string dir, string bat)
    {
        string path = Path.Combine(dir, bat);
        if (!File.Exists(path))
        {
            Console.WriteLine("[X] 没找到 " + bat + "，这个目录不像完整程序目录。");
            return 1;
        }
        var psi = new ProcessStartInfo("cmd.exe", "/d /c \"" + path + "\"")
        {
            WorkingDirectory = dir,
            UseShellExecute = false
        };
        try
        {
            using (var p = Process.Start(psi))
            {
                p.WaitForExit();
                return p.ExitCode;
            }
        }
        catch (Exception ex)
        {
            Console.WriteLine("[X] 启动失败：" + ex.Message);
            return 1;
        }
    }

    static int Extract(string target, bool verbose)
    {
        try { target = Path.GetFullPath(target); } catch (Exception ex) { Console.WriteLine("[X] 路径不对：" + ex.Message); return 1; }

        if (IsProgramDir(target) && verbose)
        {
            Console.Write("这个目录里已经有一份程序了，覆盖吗？（配置和记忆不会被删）[y/N]: ");
            string a = Console.ReadLine();
            if (!(a ?? "").Trim().ToLowerInvariant().StartsWith("y")) { Console.WriteLine("跳过了。"); return 0; }
        }

        var asm = Assembly.GetExecutingAssembly();
        string name = asm.GetManifestResourceNames()
            .FirstOrDefault(n => n.EndsWith(Payload, StringComparison.OrdinalIgnoreCase));
        if (name == null) { Console.WriteLine("[X] exe 里没有自带程序包。"); return 1; }

        Console.WriteLine("解压到：" + target);
        int files = 0;
        try
        {
            Directory.CreateDirectory(target);
            using (var stream = asm.GetManifestResourceStream(name))
            using (var zip = new ZipArchive(stream, ZipArchiveMode.Read))
            {
                foreach (var e in zip.Entries)
                {
                    string rel = e.FullName.Replace('/', Path.DirectorySeparatorChar);
                    if (rel.Contains("..")) continue;
                    string dest = Path.Combine(target, rel);
                    if (rel.EndsWith(Path.DirectorySeparatorChar.ToString()) || e.Name.Length == 0)
                    {
                        Directory.CreateDirectory(dest);
                        continue;
                    }
                    Directory.CreateDirectory(Path.GetDirectoryName(dest));
                    if (e.Name.Equals("config.json", StringComparison.OrdinalIgnoreCase) && File.Exists(dest))
                    {
                        // 老用户升级：配置文件绝不覆盖
                        continue;
                    }
                    e.ExtractToFile(dest, true);
                    files++;
                }
            }
        }
        catch (Exception ex)
        {
            Console.WriteLine("[X] 解压失败：" + ex.Message);
            return 1;
        }

        Console.WriteLine("完成，写了 " + files + " 个文件。");
        return 0;
    }

    static void Pause()
    {
        Console.WriteLine();
        Console.Write("按回车关掉这个窗口…");
        try { Console.ReadLine(); } catch { }
    }
}
