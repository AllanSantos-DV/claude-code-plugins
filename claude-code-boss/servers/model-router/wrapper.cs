using System;
using System.Diagnostics;
using System.IO;
using System.Text;

class ModelRouterWrapper {
    static int Main(string[] args) {
        string exeDir = AppDomain.CurrentDomain.BaseDirectory;
        string realClaude = Path.Combine(exeDir, "claude.real.exe");

        if (!File.Exists(realClaude)) {
            Console.Error.WriteLine("[model-router-wrapper] ERRO: claude.real.exe nao encontrado em " + exeDir);
            return 1;
        }

        // Injeta o proxy SOMENTE neste processo (e filhos). Lê de um arquivo fixo
        // gravado pelo ensure.js. Se o arquivo nao existe (roteador parado), nao
        // injeta nada e o Claude Code fala direto com a Anthropic.
        string proxyUrl = GetProxyUrl();
        if (proxyUrl != null) {
            Environment.SetEnvironmentVariable("ANTHROPIC_BASE_URL", proxyUrl);
        }

        // Repassa os argumentos com quoting CANONICO do Windows (CommandLineToArgvW).
        // Crucial para flags como --settings <json>, que contem aspas e chaves.
        string argStr = JoinArgs(args);

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
            string urlFile = Path.Combine(home, ".claude", "model-router-url.txt");
            if (!File.Exists(urlFile)) return null;
            string url = File.ReadAllText(urlFile).Trim();
            return url.Length > 0 ? url : null;
        } catch (Exception e) {
            Console.Error.WriteLine("[model-router-wrapper] aviso ao ler url do proxy: " + e.Message);
            return null;
        }
    }

    // Une os argumentos aplicando o quoting esperado por CommandLineToArgvW.
    static string JoinArgs(string[] args) {
        if (args == null || args.Length == 0) return "";
        var sb = new StringBuilder();
        for (int i = 0; i < args.Length; i++) {
            if (i > 0) sb.Append(' ');
            ArgvQuote(args[i], sb);
        }
        return sb.ToString();
    }

    // Algoritmo canonico da Microsoft (Daniel Colascione) para citar um argumento
    // de forma que CommandLineToArgvW o reconstrua identico — preserva aspas e
    // barras invertidas embutidas (necessario para JSON em --settings).
    static void ArgvQuote(string argument, StringBuilder sb) {
        if (argument.Length > 0 && argument.IndexOfAny(new[] { ' ', '\t', '\n', '\v', '"' }) < 0) {
            sb.Append(argument);
            return;
        }
        sb.Append('"');
        for (int i = 0; ; i++) {
            int backslashes = 0;
            while (i < argument.Length && argument[i] == '\\') { i++; backslashes++; }
            if (i == argument.Length) {
                sb.Append('\\', backslashes * 2);
                break;
            } else if (argument[i] == '"') {
                sb.Append('\\', backslashes * 2 + 1);
                sb.Append('"');
            } else {
                sb.Append('\\', backslashes);
                sb.Append(argument[i]);
            }
        }
        sb.Append('"');
    }
}
