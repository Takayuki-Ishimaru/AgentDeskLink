using System.Windows.Forms;
using System.IO;

namespace AgentDeskLink.TestFixture;

internal sealed class FixtureWindow : Form { protected override bool ShowWithoutActivation => true; }

internal static class Program
{
    private static readonly Dictionary<int, Form> Forms = new();
    private static System.Windows.Forms.Timer? timer;
    private static string? interferenceLog;
    [STAThread]
    private static void Main(string[] args)
    {
        ApplicationConfiguration.Initialize();
        int logIndex = Array.IndexOf(args, "--interference-log");
        if (logIndex >= 0 && logIndex + 1 < args.Length) interferenceLog = Path.GetFullPath(args[logIndex + 1]);
        bool multi=args.Contains("--multi-window");
        if(!multi){Application.Run(CreateForm(0,false));return;}
        for(int i=0;i<3;i++){var f=CreateForm(i,true);Forms[i]=f;f.Show();}
        int p=Array.IndexOf(args,"--control-dir");
        if(p>=0 && p+1<args.Length){var dir=Path.GetFullPath(args[p+1]);Directory.CreateDirectory(dir);int last=-1;
            timer=new System.Windows.Forms.Timer{Interval=20};timer.Tick+=(_,_)=>{try{
                var input=Path.Combine(dir,"input.json");if(!File.Exists(input)||new FileInfo(input).Length>65536)return;
                using var doc=System.Text.Json.JsonDocument.Parse(File.ReadAllText(input));var r=doc.RootElement;int id=r.GetProperty("id").GetInt32();if(id==last)return;last=id;
                int index=r.TryGetProperty("index",out var ix)?ix.GetInt32():0;string op=r.GetProperty("op").GetString()??"";
                switch(op){
                  case "close":if(Forms.Remove(index,out var old))old.Close();break;
                  case "reopen":if(Forms.Remove(index,out var prior))prior.Close();var fresh=CreateForm(index,true);Forms[index]=fresh;fresh.Show();break;
                  case "move":if(Forms.TryGetValue(index,out var moved)){int screen=r.GetProperty("screen").GetInt32();var area=Screen.AllScreens[Math.Clamp(screen,0,Screen.AllScreens.Length-1)].WorkingArea;moved.Location=new System.Drawing.Point(area.Left+20,area.Top+20);}break;
                  case "minimize":if(Forms.TryGetValue(index,out var mini))mini.WindowState=FormWindowState.Minimized;break;
                  case "restore":if(Forms.TryGetValue(index,out var restore))restore.WindowState=FormWindowState.Normal;break;
                }
                var states=Forms.Select(pair=>new {index=pair.Key,field=((TextBox)pair.Value.Controls.Find("FixtureText",true)[0]).Text,status=pair.Value.Controls.Find("FixtureStatus",true)[0].Text, @checked=((CheckBox)pair.Value.Controls.Find("FixtureCheck",true)[0]).Checked}).ToArray();
                var output=Path.Combine(dir,"output.json");var temp=output+".tmp";File.WriteAllText(temp,System.Text.Json.JsonSerializer.Serialize(new{id,windows=states,screens=Screen.AllScreens.Length}));File.Move(temp,output,true);
            }catch{}};timer.Start();}
        Application.Run();
    }
    private static Form CreateForm(int index,bool multi)
    {
        var form = new FixtureWindow { Text = "ADL Native UIA Fixture", Width = 520, Height = 420, StartPosition = FormStartPosition.CenterScreen };
        var panel = new FlowLayoutPanel { Name = "FixtureScroll", AccessibleName = "Fixture scroll", Dock = DockStyle.Fill, FlowDirection = FlowDirection.TopDown, WrapContents = false, AutoScroll = true, Padding = new Padding(12) };
        panel.Controls.Add(new Label { Text = "Fixture label", AutoSize = true });
        panel.Controls.Add(new TextBox { Name = "FixtureText", AccessibleName = "Fixture text", Text = multi ? $"initial-value-{index}" : "initial-value", Width = 280 });
        var status = new Label { Name = "FixtureStatus", AccessibleName = "Button clicks: 0", Text = "Button clicks: 0", AutoSize = true };
        int clicks = 0;
        var button = new Button { Name = "FixtureButton", AccessibleName = "Fixture button", Text = "Click fixture", AutoSize = true };
        button.Click += (_, _) => { clicks++; status.Text = $"Button clicks: {clicks}"; status.AccessibleName = status.Text; };
        panel.Controls.Add(button);
        panel.Controls.Add(status);
        panel.Controls.Add(new CheckBox { Name = "FixtureCheck", AccessibleName = "Fixture check", Text = "Fixture checkbox", AutoSize = true });
        var choices = new System.Windows.Controls.ListBox { Width = 220, Height = 82, SelectionMode = System.Windows.Controls.SelectionMode.Single };
        var alpha = new System.Windows.Controls.ListBoxItem { Content = "Select alpha" };
        var beta = new System.Windows.Controls.ListBoxItem { Content = "Select beta" };
        System.Windows.Automation.AutomationProperties.SetAutomationId(alpha, "FixtureSelectAlpha");
        System.Windows.Automation.AutomationProperties.SetName(alpha, "Select alpha");
        System.Windows.Automation.AutomationProperties.SetAutomationId(beta, "FixtureSelectBeta");
        System.Windows.Automation.AutomationProperties.SetName(beta, "Select beta");
        choices.Items.Add(alpha);
        choices.Items.Add(beta);
        choices.SelectedItem = alpha;
        panel.Controls.Add(new System.Windows.Forms.Integration.ElementHost { Name = "FixtureSelectHost", Child = choices, Width = 230, Height = 90 });
        panel.Controls.Add(new TextBox { Name = "FixtureReadOnly", AccessibleName = "Read only", Text = "read-only-value", ReadOnly = true, Width = 280 });
        panel.Controls.Add(new TextBox { Name = "FixturePassword", AccessibleName = "Password", Text = "CANARY_NATIVE_PASSWORD", UseSystemPasswordChar = true, Width = 280 });
        panel.Controls.Add(new Button { Name = "FixtureUnapproved", AccessibleName = "Unapproved control", Text = "Unapproved control", AutoSize = true });
        panel.Controls.Add(new Button { Name = "FixtureDelete", AccessibleName = "Delete record", Text = "Delete record", AutoSize = true });
        var focusTest = new Button { Name = "FixtureFocus", AccessibleName = "Focus test", Text = "Focus test", AutoSize = true };
        focusTest.Click += (_, _) => {
            status.Text = status.AccessibleName = "Interference fixture invoked";
            form.Activate(); button.Focus();
            // Deliberate test-only interference exercises the helper's stop guard.
            var cursor = Cursor.Position;
            var screen = Screen.FromPoint(cursor).Bounds;
            // Moving beyond the right edge is clamped and would create no interference.
            var nextX = cursor.X < screen.Left + screen.Width / 2
                ? Math.Min(screen.Right - 1, cursor.X + 20)
                : Math.Max(screen.Left, cursor.X - 20);
            Cursor.Position = new System.Drawing.Point(nextX, cursor.Y);
            var actual = Cursor.Position;
            if (interferenceLog != null) File.WriteAllText(interferenceLog, System.Text.Json.JsonSerializer.Serialize(new {
                before = new { x = cursor.X, y = cursor.Y },
                requested = new { x = nextX, y = cursor.Y },
                actual = new { x = actual.X, y = actual.Y },
                cursor_changed = actual != cursor
            }));
        };
        focusTest.Dock = DockStyle.Top;
        form.Controls.Add(focusTest); // Always visible, independent of the scroll panel position.
        for (int i = 0; i < 30; i++) panel.Controls.Add(new Label { Text = $"Scrollable row {i + 1}", AutoSize = true });
        form.Controls.Add(panel);
        if(multi){form.StartPosition=FormStartPosition.Manual;form.Location=new System.Drawing.Point(20+index*340,40+index*70);form.Width=330;form.Height=400;}
        return form;
    }
}
