using System.Text.Json;
using System.Runtime.InteropServices;
using System.Windows.Forms;
namespace AgentDeskLink.InteractiveFixture;
sealed class FixtureTextBox : TextBox {public bool SuppressSelect;protected override bool ProcessCmdKey(ref Message message,Keys keys){if(SuppressSelect&&keys==(Keys.Control|Keys.A))return true;return base.ProcessCmdKey(ref message,keys);}}
sealed class GestureCanvas : Control {
 public int Drags,Wheel;public bool Down;public Point Box=new(30,40);Point previous;
 public GestureCanvas(){Name="FixtureCanvas";AccessibleName="Gesture canvas";AccessibleRole=AccessibleRole.Pane;SetStyle(ControlStyles.Selectable|ControlStyles.UserPaint|ControlStyles.AllPaintingInWmPaint|ControlStyles.OptimizedDoubleBuffer,true);TabStop=true;BackColor=Color.White;}
 protected override void OnPaint(PaintEventArgs e){e.Graphics.Clear(Color.White);using var brush=new SolidBrush(Color.RoyalBlue);e.Graphics.FillRectangle(brush,Box.X,Box.Y,80,60);e.Graphics.DrawString($"Drags {Drags}; Wheel {Wheel}",Font,Brushes.Black,8,8);}
 protected override void OnMouseDown(MouseEventArgs e){if(e.Button==MouseButtons.Left){Focus();Down=true;Capture=true;previous=e.Location;}base.OnMouseDown(e);}
 protected override void OnMouseMove(MouseEventArgs e){if(Down){Box=new Point(Math.Clamp(Box.X+e.X-previous.X,0,Width-80),Math.Clamp(Box.Y+e.Y-previous.Y,25,Height-60));previous=e.Location;Invalidate();}base.OnMouseMove(e);}
 protected override void OnMouseUp(MouseEventArgs e){if(e.Button==MouseButtons.Left&&Down){Down=false;Capture=false;Drags++;Invalidate();}base.OnMouseUp(e);}
 protected override void OnMouseWheel(MouseEventArgs e){Wheel+=e.Delta;Invalidate();base.OnMouseWheel(e);}
}
static class Program {
 [DllImport("user32.dll")]static extern IntPtr GetForegroundWindow();
 [DllImport("user32.dll")]static extern bool SetForegroundWindow(IntPtr hwnd);
 [STAThread]static void Main(string[] args){
  ApplicationConfiguration.Initialize();var dir=Path.GetFullPath(args[0]);Directory.CreateDirectory(dir);
  var form=new Form{Text="ADL Physical Input Synthetic Fixture",Width=620,Height=650,StartPosition=FormStartPosition.Manual,Location=new Point(90,90)};
  var field=new FixtureTextBox{Name="FixtureText",AccessibleName="Fixture text",Text="Initial",Left=20,Top=45,Width=300};
  var second=new TextBox{Name="SecondText",AccessibleName="Second text",Text="Untouched",Left=340,Top=45,Width=200};
  var button=new Button{Name="FixtureButton",AccessibleName="Fixture button",Text="Fixture action",Left=20,Top=95,Width=150};
  var danger=new Button{Name="FixtureDelete",AccessibleName="Delete record",Text="Delete record",Left=340,Top=95,Width=150};
  var password=new TextBox{Name="FixturePassword",AccessibleName="Password",Text="SYNTHETIC_SECRET",UseSystemPasswordChar=true,Left=20,Top=145,Width=300};
  var canvas=new GestureCanvas{Left=20,Top=205,Width=540,Height=270};var status=new Label{Name="Status",AccessibleName="Fixture status",Left=20,Top=500,Width=550,Height=50};
  Form? auxiliary=null;int clicks=0,dangerClicks=0;bool hoverChanges=false;button.Click+=(_,_)=>{clicks++;};danger.Click+=(_,_)=>{dangerClicks++;};
  button.MouseEnter+=(_,_)=>{if(hoverChanges){button.AccessibleName="Changed on hover";button.Text="Changed on hover";}};
  var forbidden=new Panel{Name="ForbiddenParent",AccessibleName="Pay now",AccessibleRole=AccessibleRole.PushButton,Left=380,Top=220,Width=150,Height=60};var innocent=new Label{Name="InnocentChild",AccessibleName="Decoration",Text="Synthetic ancestor test",Dock=DockStyle.Fill};forbidden.Controls.Add(innocent);form.Controls.AddRange(new Control[]{field,second,button,danger,password,canvas,status,forbidden});forbidden.BringToFront();
  object Rect(Control c){var p=c.PointToScreen(Point.Empty);return new{x=p.X,y=p.Y,width=c.Width,height=c.Height};}
  object State(int id)=>new{id,ready=true,clicks,danger_clicks=dangerClicks,field=field.Text,second=second.Text,drags=canvas.Drags,wheel=canvas.Wheel,mouse_down=canvas.Down,box=new{x=canvas.Box.X,y=canvas.Box.Y},window=new{x=form.Left,y=form.Top,width=form.Width,height=form.Height},canvas=Rect(canvas),button=Rect(button),field_rect=Rect(field),second_rect=Rect(second),password_rect=Rect(password),danger_rect=Rect(danger),forbidden_rect=Rect(forbidden),foreground=(GetForegroundWindow()==form.Handle)};
  void Reply(int id){status.Text=$"Clicks {clicks}; Drags {canvas.Drags}; Wheel {canvas.Wheel}";var file=Path.Combine(dir,"output.json");var text=JsonSerializer.Serialize(State(id));for(int retry=0;;++retry){try{File.WriteAllText(file,text);break;}catch(IOException){if(retry>=100)throw;Thread.Sleep(2);}}}
  var timer=new System.Windows.Forms.Timer{Interval=10};int prior=-1;timer.Tick+=(_,_)=>{try{var input=Path.Combine(dir,"input.json");if(!File.Exists(input))return;using var doc=JsonDocument.Parse(File.ReadAllText(input));var r=doc.RootElement;int id=r.GetProperty("id").GetInt32();if(id==prior)return;prior=id;switch(r.GetProperty("op").GetString()){
   case "foreground":if(GetForegroundWindow()!=form.Handle){form.Activate();SetForegroundWindow(form.Handle);}break;
   case "other_window":auxiliary??=new Form{Text="ADL Same App Alternate Fixture",Width=260,Height=140,StartPosition=FormStartPosition.Manual,Location=new Point(760,90)};auxiliary.Show();auxiliary.Activate();SetForegroundWindow(auxiliary.Handle);break;
   case "focus_canvas":canvas.Focus();break;
   case "focus_second":second.Focus();break;
   case "suppress_select":field.SuppressSelect=r.GetProperty("enabled").GetBoolean();break;
   case "select_field":field.Select(r.GetProperty("start").GetInt32(),r.GetProperty("length").GetInt32());break;
   case "hover_changes":hoverChanges=r.GetProperty("enabled").GetBoolean();button.AccessibleName="Fixture button";button.Text="Fixture action";break;
   case "move_field":field.Left+=50;break;
   case "readonly":field.ReadOnly=r.GetProperty("enabled").GetBoolean();break;
   case "close":form.Close();break;
  }Reply(id);}catch(Exception ex){File.WriteAllText(Path.Combine(dir,"error.txt"),ex.ToString());}};form.Shown+=(_,_)=>{Reply(0);timer.Start();};Application.Run(form);timer.Dispose();auxiliary?.Dispose();
 }
}
