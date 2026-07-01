// wrapper.cs — Boss model-router shim para o binário claude-code (Windows/Desktop).
//
// PROBLEMA (regressão Claude Desktop 2.1.197): ao spawnar o claude-code, o app
// FORÇA ANTHROPIC_BASE_URL=https://api.anthropic.com no env do processo +
// CLAUDE_CODE_ENTRYPOINT=claude-desktop. Nesse modo o claude-code prioriza o env
// do PROCESSO e IGNORA o bloco `env` do ~/.claude/settings.json → o roteamento
// (proxy local) deixou de ser aplicado na GUI. Provado em laboratório e no
// próprio código do app (app.asar: production.apiHost = "https://api.anthropic.com",
// hardcoded). As duas abordagens externas (User env var e settings.json env)
// estão mortas para o Desktop.
//
// SOLUÇÃO (isolada, prova E2E): o plugin renomeia o claude.exe real para
// claude-real.exe e instala ESTE wrapper como claude.exe. Quando o app spawna o
// "claude.exe", cai aqui: trocamos ANTHROPIC_BASE_URL pelo proxy local e
// chamamos o claude-real.exe verbatim, herdando stdio. A GUI não muda. Afeta
// SOMENTE o claude.exe do Claude Code — zero env global, zero PATH, zero hosts.
//
// GENÉRICO: descobre claude-real.exe relativo ao próprio path → 1 binário serve
// todas as versões. FAIL-OPEN: se o url.txt está ausente/vazio OU a porta do
// proxy está fechada, NÃO troca a URL — o Claude vai direto e nunca quebra.
//
// Compilar com .NET Framework (sempre presente no Windows), SEM dependências:
//   C:\Windows\Microsoft.NET\Framework64\v4.0.30319\csc.exe /nologo /out:claude.exe wrapper.cs

using System;
using System.Diagnostics;
using System.IO;
using System.Net.Sockets;
using System.Runtime.InteropServices;

class Wrapper
{
    // ── Job Object: matar o wrapper mata o claude-real, MAS deixa netos escaparem ──
    // KILL_ON_JOB_CLOSE garante que, se o wrapper morrer, o claude-real morre junto
    // (sem claude-code órfão). SILENT_BREAKAWAY_OK é ESSENCIAL: sem ela, os netos do
    // claude-real (hooks, MCP servers e principalmente o model-router, que é spawnado
    // DETACHED para persistir entre reaberturas do app) herdariam o job e seriam
    // mortos junto ao fechar o Desktop — matando o roteador e quebrando o roteamento
    // na reabertura seguinte. Com SILENT_BREAKAWAY_OK, filhos de membros do job NÃO
    // são associados ao job: o KILL atinge apenas o claude-real (membro explícito) e
    // o roteador detached sobrevive, restaurando o comportamento pré-shim.
    [DllImport("kernel32.dll", CharSet = CharSet.Unicode)]
    static extern IntPtr CreateJobObject(IntPtr a, string lpName);
    [DllImport("kernel32.dll")]
    static extern bool SetInformationJobObject(IntPtr hJob, int infoType, IntPtr lpJobObjectInfo, uint cbJobObjectInfoLength);
    [DllImport("kernel32.dll")]
    static extern bool AssignProcessToJobObject(IntPtr hJob, IntPtr hProcess);

    const int JobObjectExtendedLimitInformation = 9;
    const uint JOB_OBJECT_LIMIT_KILL_ON_JOB_CLOSE = 0x2000;
    const uint JOB_OBJECT_LIMIT_SILENT_BREAKAWAY_OK = 0x1000;

    [StructLayout(LayoutKind.Sequential)]
    struct JOBOBJECT_BASIC_LIMIT_INFORMATION
    {
        public long PerProcessUserTimeLimit;
        public long PerJobUserTimeLimit;
        public uint LimitFlags;
        public UIntPtr MinimumWorkingSetSize;
        public UIntPtr MaximumWorkingSetSize;
        public uint ActiveProcessLimit;
        public UIntPtr Affinity;
        public uint PriorityClass;
        public uint SchedulingClass;
    }

    [StructLayout(LayoutKind.Sequential)]
    struct IO_COUNTERS
    {
        public ulong ReadOperationCount;
        public ulong WriteOperationCount;
        public ulong OtherOperationCount;
        public ulong ReadTransferCount;
        public ulong WriteTransferCount;
        public ulong OtherTransferCount;
    }

    [StructLayout(LayoutKind.Sequential)]
    struct JOBOBJECT_EXTENDED_LIMIT_INFORMATION
    {
        public JOBOBJECT_BASIC_LIMIT_INFORMATION BasicLimitInformation;
        public IO_COUNTERS IoInfo;
        public UIntPtr ProcessMemoryLimit;
        public UIntPtr JobMemoryLimit;
        public UIntPtr PeakProcessMemoryUsed;
        public UIntPtr PeakJobMemoryUsed;
    }

    static int Main()
    {
        string self = Process.GetCurrentProcess().MainModule.FileName;
        string dir = Path.GetDirectoryName(self);
        string real = Path.Combine(dir, "claude-real.exe");

        if (!File.Exists(real))
        {
            // Sem o binário real ao lado não há o que delegar — falha clara em vez
            // de loop silencioso. (Em operação normal o instalador garante o par.)
            Console.Error.WriteLine("[boss-shim] claude-real.exe não encontrado em " + dir);
            return 1;
        }

        var psi = new ProcessStartInfo();
        psi.FileName = real;
        // Repassa os argumentos VERBATIM (o app passa --settings com JSON complexo;
        // re-parsear/re-quotar quebraria). Environment.CommandLine inclui o exe como
        // 1º token — removemos só ele e mantemos o resto byte-a-byte.
        psi.Arguments = StripFirstToken(Environment.CommandLine);
        psi.UseShellExecute = false; // herda stdin/stdout/stderr (stream-json transparente)

        string url = ReadProxyUrl();
        if (url != null && PortOpen(url))
        {
            // Só roteamos quando o proxy está de fato vivo.
            psi.EnvironmentVariables["ANTHROPIC_BASE_URL"] = url;
        }
        // FAIL-OPEN: url.txt ausente/vazio ou porta fechada → mantém o env como veio
        // (api.anthropic.com) e o Claude funciona direto. O shim nunca derruba a GUI.

        IntPtr job = SetupJob();

        Process p;
        try
        {
            p = Process.Start(psi);
        }
        catch (Exception e)
        {
            Console.Error.WriteLine("[boss-shim] falha ao iniciar claude-real: " + e.Message);
            return 1;
        }

        if (job != IntPtr.Zero)
        {
            try
            {
                AssignProcessToJobObject(job, p.Handle);
            }
            catch (Exception e)
            {
                // Sem o job a delegação ainda funciona; só perde o kill-on-close.
                Console.Error.WriteLine("[boss-shim] aviso: AssignProcessToJobObject falhou: " + e.Message);
            }
        }

        p.WaitForExit();
        return p.ExitCode;
    }

    // Cria um Job Object com KILL_ON_JOB_CLOSE | SILENT_BREAKAWAY_OK: se o wrapper
    // for morto, o claude-real (membro explícito) morre junto — mas os netos
    // detached (o model-router) NÃO entram no job e sobrevivem. Ver nota no topo.
    static IntPtr SetupJob()
    {
        try
        {
            IntPtr job = CreateJobObject(IntPtr.Zero, null);
            if (job == IntPtr.Zero) return IntPtr.Zero;
            var info = new JOBOBJECT_EXTENDED_LIMIT_INFORMATION();
            info.BasicLimitInformation.LimitFlags =
                JOB_OBJECT_LIMIT_KILL_ON_JOB_CLOSE | JOB_OBJECT_LIMIT_SILENT_BREAKAWAY_OK;
            int len = Marshal.SizeOf(info);
            IntPtr ptr = Marshal.AllocHGlobal(len);
            try
            {
                Marshal.StructureToPtr(info, ptr, false);
                SetInformationJobObject(job, JobObjectExtendedLimitInformation, ptr, (uint)len);
            }
            finally
            {
                Marshal.FreeHGlobal(ptr);
            }
            return job;
        }
        catch (Exception e)
        {
            Console.Error.WriteLine("[boss-shim] aviso: setup do job falhou: " + e.Message);
            return IntPtr.Zero;
        }
    }

    // Lê a URL viva do proxy de ~/.claude/model-router-url.txt (escrita pelo ensure
    // SOMENTE quando o roteador está vivo). Ausente/vazio → null (fail-open).
    static string ReadProxyUrl()
    {
        try
        {
            string home = Environment.GetEnvironmentVariable("USERPROFILE");
            if (string.IsNullOrEmpty(home)) return null;
            string f = Path.Combine(home, ".claude", "model-router-url.txt");
            if (!File.Exists(f)) return null;
            string u = File.ReadAllText(f).Trim();
            return u.Length > 0 ? u : null;
        }
        catch (Exception)
        {
            return null; // qualquer erro de leitura → fail-open
        }
    }

    // TCP check rápido (~300ms) para confirmar que o proxy está ouvindo antes de
    // redirecionar. Porta fechada → false → fail-open (Claude direto).
    static bool PortOpen(string url)
    {
        try
        {
            var uri = new Uri(url);
            using (var c = new TcpClient())
            {
                IAsyncResult ar = c.BeginConnect(uri.Host, uri.Port, null, null);
                bool ok = ar.AsyncWaitHandle.WaitOne(300);
                if (ok)
                {
                    c.EndConnect(ar);
                    return true;
                }
                return false;
            }
        }
        catch (Exception)
        {
            return false; // host/porta inválidos ou inacessíveis → fail-open
        }
    }

    // Remove apenas o 1º token (o caminho do exe) de Environment.CommandLine,
    // preservando o restante dos argumentos byte-a-byte (sem re-quoting).
    static string StripFirstToken(string cmd)
    {
        int i = 0;
        if (cmd.Length > 0 && cmd[0] == '"')
        {
            i = 1;
            while (i < cmd.Length && cmd[i] != '"') i++;
            if (i < cmd.Length) i++; // pula a aspa de fechamento
        }
        else
        {
            while (i < cmd.Length && cmd[i] != ' ' && cmd[i] != '\t') i++;
        }
        while (i < cmd.Length && (cmd[i] == ' ' || cmd[i] == '\t')) i++;
        return i < cmd.Length ? cmd.Substring(i) : "";
    }
}
