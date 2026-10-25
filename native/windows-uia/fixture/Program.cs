using System.Windows.Forms;

namespace AgentDeskLink.TestFixture;

internal static class Program
{
    [STAThread]
    private static void Main(string[] args)
    {
        ApplicationConfiguration.Initialize();
        if(args.Contains("--foreground")){
            var human=new Form{Text="ADL Human Work Simulation",Width=500,Height=240};
            human.Controls.Add(new TextBox{Name="HumanInput",Text="Human input remains here",Dock=DockStyle.Fill,Multiline=true});
            Application.Run(human);return;
        }
        var form = new Form { Text = "AgentDeskLink UIA Fixture", Width = 520, Height = 420, StartPosition = FormStartPosition.CenterScreen };
        var panel = new FlowLayoutPanel { Name="FixtureScroll",AccessibleName="Fixture scroll",Dock = DockStyle.Fill, FlowDirection = FlowDirection.TopDown, WrapContents = false, AutoScroll = true, Padding = new Padding(12) };
        panel.Controls.Add(new Label { Text = "Fixture label", AutoSize = true });
        panel.Controls.Add(new TextBox { Name = "FixtureText", AccessibleName = "Fixture text", Text = "initial-value", Width = 280 });
        var status=new Label {Name="FixtureStatus",AccessibleName="Button clicks: 0",Text="Button clicks: 0",AutoSize=true};
        int clicks=0;
        var button=new Button { Name = "FixtureButton", AccessibleName = "Fixture button", Text = "Click fixture", AutoSize = true };
        button.Click+=(_,_)=>{clicks++;status.Text=$"Button clicks: {clicks}";status.AccessibleName=status.Text;};
        panel.Controls.Add(button);panel.Controls.Add(status);
        panel.Controls.Add(new CheckBox { Name = "FixtureCheck", AccessibleName = "Fixture check", Text = "Fixture checkbox", AutoSize = true });
        panel.Controls.Add(new ComboBox { Name = "FixtureSelect", AccessibleName = "Fixture selection", DropDownStyle = ComboBoxStyle.DropDownList, Items = { "alpha", "beta", "gamma" }, SelectedIndex = 0, Width = 220 });
        panel.Controls.Add(new RadioButton {Name="FixtureSelectAlpha",AccessibleName="Select alpha",Text="Select alpha",Checked=true,AutoSize=true});
        panel.Controls.Add(new RadioButton {Name="FixtureSelectBeta",AccessibleName="Select beta",Text="Select beta",AutoSize=true});
        panel.Controls.Add(new TextBox {Name="FixtureReadOnly",AccessibleName="Read only",Text="read-only-value",ReadOnly=true,Width=280});
        panel.Controls.Add(new TextBox {Name="FixturePassword",AccessibleName="Password",Text="CANARY_NATIVE_PASSWORD",UseSystemPasswordChar=true,Width=280});
        panel.Controls.Add(new Button {Name="FixtureUnapproved",AccessibleName="Unapproved control",Text="Unapproved control",AutoSize=true});
        panel.Controls.Add(new Button {Name="FixtureDelete",AccessibleName="Delete record",Text="Delete record",AutoSize=true});
        for (int i = 0; i < 30; i++) panel.Controls.Add(new Label { Text = $"Scrollable row {i + 1}", AutoSize = true });
        form.Controls.Add(panel);
        Application.Run(form);
    }
}
