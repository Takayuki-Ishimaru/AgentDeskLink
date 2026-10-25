using System.Collections.Concurrent;
using System.Diagnostics;
using System.IO;
using System.Runtime.InteropServices;
using System.Security.Cryptography;
using System.Text;
using System.Text.Json;
using System.Text.Json.Serialization;
using System.Windows.Automation;

namespace AgentDeskLink.WindowsUia;

internal static class Program
{
    private const int MaxLineChars = 64 * 1024;
    private const int MaxNodes = 1000;
    private const int MaxSnapshotChars = 512 * 1024;
    private static Helper? _helper;

    [STAThread]
    private static int Main(string[] args)
    {
        if (args.Length == 1 && args[0] is "--help" or "-h" or "-Help")
        {
            Console.Error.WriteLine("Usage: AgentDeskLink.WindowsUia --app-id <id> --app-path <absolute-exe-path>");
            return 0;
        }
        try { _helper = new Helper(ParseArgs(args)); }
        catch { Console.Error.WriteLine("Invalid helper configuration."); return 2; }

        while (true)
        {
            string? line;
            try { line = ReadBoundedLine(Console.In); }
            catch { Console.Out.WriteLine(JsonSerializer.Serialize(Response.Fail("", "E_INVALID_REQUEST"), JsonOptions)); Console.Out.Flush(); continue; }
            if (line is null) break;
            Response response;
            string requestId = "";
            try
            {
                if (line.Length > MaxLineChars) throw new Fault("E_INVALID_REQUEST");
                using var doc = JsonDocument.Parse(line, new JsonDocumentOptions { MaxDepth = 12 });
                var req = Request.Parse(doc.RootElement);
                requestId = req.RequestId;
                response = _helper.Handle(req);
            }
            catch (Fault f) { response = Response.Fail(requestId, f.Code); }
            catch (JsonException) { response = Response.Fail(requestId, "E_INVALID_REQUEST"); }
            catch { response = Response.Fail(requestId, "E_INTERNAL"); }
            try { Console.Out.WriteLine(JsonSerializer.Serialize(response, JsonOptions)); Console.Out.Flush(); }
            catch { Console.Out.WriteLine("{\"ok\":false,\"request_id\":\"\",\"error\":{\"code\":\"E_INTERNAL\",\"message\":\"Request failed.\"}}"); }
        }
        return 0;
    }

    private static string? ReadBoundedLine(TextReader reader)
    {
        var buffer = new StringBuilder(Math.Min(MaxLineChars, 4096));
        bool tooLong = false;
        while (true)
        {
            int c = reader.Read();
            if (c < 0) return buffer.Length == 0 && !tooLong ? null : tooLong ? throw new InvalidDataException() : buffer.ToString();
            if (c == '\n') return tooLong ? throw new InvalidDataException() : buffer.ToString().TrimEnd('\r');
            if (buffer.Length < MaxLineChars) buffer.Append((char)c);
            else tooLong = true;
        }
    }

    private static readonly JsonSerializerOptions JsonOptions = new(JsonSerializerDefaults.Web)
    { DefaultIgnoreCondition = JsonIgnoreCondition.WhenWritingNull, MaxDepth = 12 };

    private static Config ParseArgs(string[] args)
    {
        string? id = null, path = null;
        for (int i = 0; i < args.Length; i++)
        {
            if (i + 1 >= args.Length) throw new ArgumentException();
            if (args[i] == "--app-id") id = args[++i];
            else if (args[i] == "--app-path") path = args[++i];
            else throw new ArgumentException();
        }
        if (string.IsNullOrWhiteSpace(id) || id.Length > 100 || string.IsNullOrWhiteSpace(path) || !Path.IsPathFullyQualified(path)) throw new ArgumentException();
        string canonical = Path.GetFullPath(path);
        if (!File.Exists(canonical)) throw new ArgumentException();
        return new(id!, canonical);
    }

    private sealed record Config(string AppId, string AppPath);
    private sealed class Fault(string code) : Exception { public string Code { get; } = code; }
    private sealed record Request(string Op, string RequestId, string? TargetId, string? Mode, string? SessionId, string? ElementId, string? Action, string? Value)
    {
        private static readonly HashSet<string> Fields = ["op", "request_id", "target_id", "mode", "session_id", "element_id", "action", "value"];
        public static Request Parse(JsonElement root)
        {
            if (root.ValueKind != JsonValueKind.Object) throw new Fault("E_INVALID_REQUEST");
            foreach (var p in root.EnumerateObject()) if (!Fields.Contains(p.Name)) throw new Fault("E_INVALID_REQUEST");
            string Get(string n, int max = 128) { if (!root.TryGetProperty(n, out var v) || v.ValueKind != JsonValueKind.String) return ""; var s = v.GetString() ?? ""; if (s.Length > max) throw new Fault("E_INVALID_REQUEST"); return s; }
            string? Opt(string n, int max = 4096) { if (!root.TryGetProperty(n, out var v) || v.ValueKind == JsonValueKind.Null) return null; if (v.ValueKind != JsonValueKind.String) throw new Fault("E_INVALID_REQUEST"); var s=v.GetString(); if (s is null || s.Length > max) throw new Fault("E_INVALID_REQUEST"); return s; }
            string op = Get("op", 32), requestId = Get("request_id");
            if (requestId.Length == 0 || op is not ("discover" or "open" or "snapshot" or "act" or "close")) throw new Fault("E_INVALID_REQUEST");
            return new(op, requestId, Opt("target_id",128), Opt("mode",64), Opt("session_id",128), Opt("element_id",128), Opt("action",32), Opt("value"));
        }
    }
    private sealed record Error(string Code, string Message);
    private sealed record Response(bool Ok, [property: JsonPropertyName("request_id")] string RequestId, object? Result = null, Error? Error = null)
    {
        public static Response Pass(string id, object result) => new(true,id,result);
        public static Response Fail(string id,string code) => new(false,id,null,new(code, code switch {
            "E_INVALID_REQUEST" => "The request is malformed or exceeds a protocol limit.",
            "E_APP_NOT_ALLOWED" => "The target is not the configured certified application.",
            "E_INTERFERENCE_RISK" => "Strict isolation is unavailable for desktop UI Automation.",
            "E_NO_TARGET" => "No live window was found for the configured application.",
            "E_STALE_HANDLE" => "The handle is unknown, expired, or no longer current.",
            "E_UNSUPPORTED_ACTION" => "Semantic mutations are disabled until non-focusing UIA is verified.",
            "E_FOCUS_CHANGED" => "Foreground, focus, or cursor changed around the action.",
            _ => "The request could not be completed." }));
    }
    private sealed record ElementDto(string Id, string Role, string? Name, string? Value, bool Enabled, bool? Checked, bool? Selected);
    private sealed record Session(string Id, int Pid, long StartTicks, long Hwnd, AutomationElement Root, Dictionary<string, AutomationElement> Elements, Dictionary<string, string> StableIds, long Revision, string Fingerprint);

    private sealed class Helper
    {
        private readonly Config _config;
        private readonly string _targetId = Opaque();
        private readonly Dictionary<string, Session> _sessions = new(StringComparer.Ordinal);
        public Helper(Config config) => _config = config;

        public Response Handle(Request r)
        {
            return r.Op switch
            {
                "discover" => Discover(r),
                "open" => Open(r),
                "snapshot" => Snapshot(r),
                "act" => Act(r),
                "close" => Close(r),
                _ => throw new Fault("E_INVALID_REQUEST")
            };
        }

        private Response Discover(Request r)
        {
            var found = FindConfiguredWindow();
            return Response.Pass(r.RequestId, new { target_id = _targetId, application_id = _config.AppId, available = found is not null, capabilities = new[] { "snapshot", "background_semantic_observation" } });
        }
        private Response Open(Request r)
        {
            if (r.Mode == "strict_isolated") throw new Fault("E_INTERFERENCE_RISK");
            if (r.Mode != "background_semantic" || r.TargetId != _targetId) throw new Fault("E_APP_NOT_ALLOWED");
            if (_sessions.Count >= 16) throw new Fault("E_RESOURCE_LIMIT");
            var hit = FindConfiguredWindow() ?? throw new Fault("E_NO_TARGET");
            AutomationElement root;
            try { root = AutomationElement.FromHandle((nint)hit.Hwnd); } catch { throw new Fault("E_NO_TARGET"); }
            var s = new Session(Opaque(), hit.Pid, hit.StartTicks, hit.Hwnd, root, new(StringComparer.Ordinal), new(StringComparer.Ordinal), 0, "");
            _sessions.Add(s.Id, s);
            return Response.Pass(r.RequestId, new { session_id = s.Id, mode = "background_semantic", mutations_enabled = false, reason = "AutoSetFocus=false cannot be verified on the managed UIA client." });
        }
        private Response Snapshot(Request r)
        {
            var s = GetSession(r.SessionId);
            Revalidate(s);
            var (items, fingerprint, truncated) = Walk(s);
            long revision = s.Revision;
            if (fingerprint != s.Fingerprint) revision++;
            s = s with { Revision = revision, Fingerprint = fingerprint };
            _sessions[s.Id] = s;
            return Response.Pass(r.RequestId, new { session_id = s.Id, revision, fingerprint, elements = items, truncated });
        }
        private Response Act(Request r)
        {
            var s = GetSession(r.SessionId);
            Revalidate(s);
            if (r.ElementId is null || !s.Elements.ContainsKey(r.ElementId)) throw new Fault("E_STALE_HANDLE");
            // The managed wrapper does not expose a supported way to prove the setting applies
            // to its shared IUIAutomation2 instance. Fail closed before invoking any provider.
            throw new Fault("E_UNSUPPORTED_ACTION");
        }
        private Response Close(Request r)
        {
            var s = GetSession(r.SessionId);
            _sessions.Remove(s.Id);
            return Response.Pass(r.RequestId, new { closed = true });
        }
        private Session GetSession(string? id)
        {
            if (id is null || !_sessions.TryGetValue(id, out var s)) throw new Fault("E_STALE_HANDLE");
            return s;
        }
        private void Revalidate(Session s)
        {
            try
            {
                using var p = Process.GetProcessById(s.Pid);
                if (p.HasExited || p.StartTime.ToUniversalTime().Ticks != s.StartTicks || !SamePath(p.MainModule?.FileName, _config.AppPath)) throw new Fault("E_APP_NOT_ALLOWED");
                if (!IsWindow((nint)s.Hwnd) || WindowPid((nint)s.Hwnd) != s.Pid) throw new Fault("E_STALE_HANDLE");
            }
            catch (Fault) { throw; }
            catch { throw new Fault("E_NO_TARGET"); }
        }
        private static (List<ElementDto> Items, string Fingerprint, bool Truncated) Walk(Session s)
        {
            var result = new List<ElementDto>(); var q = new Queue<AutomationElement>(); q.Enqueue(s.Root); int visited=0; int estimatedChars=0; bool truncated=false;
            var nextMap = new Dictionary<string, AutomationElement>(StringComparer.Ordinal);
            var activeRuntimeIds = new HashSet<string>(StringComparer.Ordinal);
            while (q.Count > 0)
            {
                if (++visited > MaxNodes) { truncated=true; break; }
                var e=q.Dequeue();
                try
                {
                    string role=e.Current.ControlType?.ProgrammaticName?.Replace("ControlType.","") ?? "unknown";
                    string rawName=e.Current.Name ?? ""; bool sensitive=e.Current.IsPassword || LooksSensitive(rawName);
                    string? name=sensitive ? null : Clip(rawName,256);
                    string? value=null;
                    if (!sensitive && e.TryGetCurrentPattern(ValuePattern.Pattern,out object pat) && pat is ValuePattern vp)
                    {
                        string candidate = vp.Current.Value ?? "";
                        if (!LooksSensitive(candidate)) value=Clip(candidate,256);
                    }
                    string runtimeKey = string.Join(",", e.GetRuntimeId());
                    activeRuntimeIds.Add(runtimeKey);
                    if (!s.StableIds.TryGetValue(runtimeKey, out var id)) s.StableIds[runtimeKey] = id = Opaque();
                    nextMap[id]=e;
                    bool? checkedValue=null, selected=null;
                    if(e.TryGetCurrentPattern(TogglePattern.Pattern,out object tp) && tp is TogglePattern toggle) checkedValue=toggle.Current.ToggleState==ToggleState.On;
                    if(e.TryGetCurrentPattern(SelectionItemPattern.Pattern,out object sp) && sp is SelectionItemPattern sel) selected=sel.Current.IsSelected;
                    var dto = new ElementDto(id,role,name,value,e.Current.IsEnabled,checkedValue,selected);
                    int size = JsonSerializer.Serialize(dto, JsonOptions).Length;
                    if (estimatedChars + size > MaxSnapshotChars) { truncated=true; break; }
                    result.Add(dto); estimatedChars += size;
                    var walker=TreeWalker.ControlViewWalker; var child=walker.GetFirstChild(e);
                    while(child is not null && q.Count < MaxNodes) { q.Enqueue(child); child=walker.GetNextSibling(child); }
                    if (child is not null) truncated=true;
                }
                catch { /* inaccessible elements are skipped without exposing provider details */ }
            }
            foreach (var key in s.StableIds.Keys.Where(k => !activeRuntimeIds.Contains(k)).ToArray()) s.StableIds.Remove(key);
            s.Elements.Clear(); foreach(var kv in nextMap) s.Elements[kv.Key]=kv.Value;
            string material=string.Join("\n",result.Select(x=>$"{x.Role}|{x.Name}|{x.Value}|{x.Enabled}|{x.Checked}|{x.Selected}"));
            string fingerprint=Convert.ToHexString(SHA256.HashData(Encoding.UTF8.GetBytes(material)))[..24];
            return(result,fingerprint,truncated);
        }
        private static bool LooksSensitive(string s) => s.Length > 0 && (s.Contains("password",StringComparison.OrdinalIgnoreCase) || s.Contains("secret",StringComparison.OrdinalIgnoreCase) || s.Contains("token",StringComparison.OrdinalIgnoreCase) || s.Contains("credential",StringComparison.OrdinalIgnoreCase));
        private static string Clip(string s,int n) => s.Length<=n?s:s[..n];
        private (int Pid,long StartTicks,long Hwnd)? FindConfiguredWindow()
        {
            foreach(var p in Process.GetProcesses())
            {
                try
                {
                    using(p)
                    {
                        if(p.HasExited || !SamePath(p.MainModule?.FileName,_config.AppPath)) continue;
                        long start=p.StartTime.ToUniversalTime().Ticks;
                        nint hwnd=p.MainWindowHandle;
                        if(hwnd==0 || !IsWindow(hwnd) || WindowPid(hwnd)!=p.Id) continue;
                        return(p.Id,start,(long)hwnd);
                    }
                }
                catch { }
            }
            return null;
        }
        private static bool SamePath(string? a,string b) { try { return a is not null && string.Equals(Path.GetFullPath(a),Path.GetFullPath(b),StringComparison.OrdinalIgnoreCase); } catch { return false; } }
        private static string Opaque() => Convert.ToHexString(RandomNumberGenerator.GetBytes(16)).ToLowerInvariant();
        [DllImport("user32.dll")] private static extern bool IsWindow(nint hwnd);
        [DllImport("user32.dll")] private static extern uint GetWindowThreadProcessId(nint hwnd,out uint pid);
        private static int WindowPid(nint hwnd) { GetWindowThreadProcessId(hwnd,out uint pid); return unchecked((int)pid); }
    }
}
