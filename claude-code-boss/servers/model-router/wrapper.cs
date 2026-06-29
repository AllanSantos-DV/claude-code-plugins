using System;
using System.Diagnostics;
using System.IO;
using System.Text.RegularExpressions;

class ModelRouterWrapper {
    static int Main(string[] args) {
        string exeDir = AppDomain.CurrentDomain.BaseDirectory;
        string realClaude = Path.Combine(exeDir, "claude.real.exe");

        if (!File.Exists(realClaude)) {
            Console.Error.WriteLine("[model-router-wrapper] ERRO: claude.real.exe nao encontrado em " + exeDir);
            return 1;
        }

        // Descobre porta do proxy via state.json
        string proxyUrl = GetProxyUrl();
        if (proxyUrl != null) {
            Environment.SetEnvironmentVariable("ANTHROPIC_BASE_URL", proxyUrl);
        }

        // Monta args como string (simples, sem escaping complexo — Claude Code usa args diretos)
        string argStr = args.Length > 0 ? string.Join(" ", Array.ConvertAll(args, a => a.Contains(" ") ? "\"" + a + "\"" : a)) : "";

        var psi = new ProcessStartInfo(realClaude, argStr) {
            UseShellExecute = false,
            CreateNoWindow  = false,
        };

        var proc = Process.Start(psi);
        if (proc == null) return 1;
        proc.WaitForExit();
        return proc.ExitCode;
    }

    static string GetProxyUrl() {
        try {
            string home = Environment.GetFolderPath(Environment.SpecialFolder.UserProfile);
            string stateFile = Path.Combine(home, ".claude", "plugins", "data",
                "claude-code-boss", "model-router", "state.json");
            if (!File.Exists(stateFile)) return null;
            string json = File.ReadAllText(stateFile);
            var m = Regex.Match(json, @"""port""\s*:\s*(\d+)");
            if (!m.Success) return null;
            int port = int.Parse(m.Groups[1].Value);
            return "http://127.0.0.1:" + port;
        } catch { return null; }
    }
}
