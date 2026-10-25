// Included inside the backend's private namespace. Never built as a public API.
std::string PublicRole(const std::string& role){
  if(role=="edit")return "textbox";if(role=="listitem")return "option";if(role=="radiobutton")return "radio";
  if(role=="hyperlink")return "link";if(role=="tabitem")return "tab";return role;
}
bool ExactFields(const json& doc,std::initializer_list<const char*> fields){
  if(!doc.is_object())return false;for(auto it=doc.begin();it!=doc.end();++it){bool found=false;for(const auto* field:fields)if(it.key()==field){found=true;break;}if(!found)return false;}return true;
}
bool ParseInteractiveConfig(const json& doc,std::vector<InputSurface>& out,bool& enabled){
  enabled=false;out.clear();if(doc.is_object()&&doc.empty())return true;
  if(!doc.is_object()||!ExactFields(doc,{"enabled","surfaces"})||!doc.contains("enabled")||!doc["enabled"].is_boolean()||!doc.contains("surfaces")||!doc["surfaces"].is_array()||doc["surfaces"].size()>16)return false;
  std::set<std::string> ids;
  for(const auto& entry:doc["surfaces"]){
    if(!entry.is_object()||!ExactFields(entry,{"id","region","kinds","swipe_backend"})||!entry.contains("id")||!entry["id"].is_string()||!entry.contains("region")||!entry["region"].is_object()||!ExactFields(entry["region"],{"x","y","width","height"})||entry["region"].size()!=4||!entry.contains("kinds")||!entry["kinds"].is_array()||entry["kinds"].empty()||entry["kinds"].size()>2)return false;
    InputSurface surface;surface.id=entry["id"].get<std::string>();if(surface.id.empty()||ToWide(surface.id).empty()||ToWide(surface.id).size()>100||!ids.insert(surface.id).second)return false;
    const auto& r=entry["region"];for(const auto* key:{"x","y","width","height"})if(!r[key].is_number_integer()||r[key].get<long long>()<0||r[key].get<long long>()>4096)return false;
    const LONG x=r["x"].get<LONG>(),y=r["y"].get<LONG>(),w=r["width"].get<LONG>(),h=r["height"].get<LONG>();if(w<=0||h<=0||x+w>4096||y+h>4096)return false;surface.region={x,y,x+w,y+h};
    for(const auto& kind:entry["kinds"]){if(!kind.is_string())return false;const auto k=kind.get<std::string>();if(k=="drag"&&!surface.drag)surface.drag=true;else if(k=="swipe"&&!surface.swipe)surface.swipe=true;else return false;}
    if(entry.contains("swipe_backend")){if(!entry["swipe_backend"].is_string())return false;surface.swipe_backend=entry["swipe_backend"].get<std::string>();if(surface.swipe_backend!="scroll"&&surface.swipe_backend!="touch")return false;}
    if(surface.swipe&&surface.swipe_backend.empty())surface.swipe_backend="scroll";out.push_back(surface);
  }
  enabled=doc["enabled"].get<bool>();return true;
}
Status ReadSelection(IUIAutomationElement* element,SelectionProof& out){
  out=SelectionProof{};VARIANT available;VariantInit(&available);
  const HRESULT available_status=element->GetCurrentPropertyValue(UIA_IsTextPatternAvailablePropertyId,&available);
  const bool available_known=SUCCEEDED(available_status)&&available.vt==VT_BOOL;const bool supported=available_known&&available.boolVal!=VARIANT_FALSE;VariantClear(&available);
  if(!available_known)return Status::Fail("E_POLICY_DENIED","text selection support cannot be verified");
  if(!supported)return Status::Ok(); // UIA provider explicitly exposes no text selection contract.
  ComPtr<IUIAutomationTextPattern> pattern;
  if(FAILED(element->GetCurrentPatternAs(UIA_TextPatternId,IID_PPV_ARGS(&pattern)))||!pattern)return Status::Fail("E_POLICY_DENIED","text selection pattern cannot be read");
  out.supported=true;ComPtr<IUIAutomationTextRangeArray> selection;
  if(FAILED(pattern->GetSelection(&selection))||!selection)return Status::Fail("E_POLICY_DENIED","text selection cannot be verified");
  int count=0;if(FAILED(selection->get_Length(&count))||count<0||count>16)return Status::Fail("E_RESOURCE_LIMIT","text selection exceeds the bounded confirmation contract");
  for(int i=0;i<count;++i){ComPtr<IUIAutomationTextRange> range,copy;if(FAILED(selection->GetElement(i,&range))||!range||FAILED(range->Clone(&copy))||!copy)return Status::Fail("E_POLICY_DENIED","text selection cannot be retained");out.ranges.push_back(copy);}
  return Status::Ok();
}
bool SameSelection(IUIAutomationElement* element,const SelectionProof& before){
  SelectionProof after;auto status=ReadSelection(element,after);if(!status.ok()||before.supported!=after.supported||before.ranges.size()!=after.ranges.size())return false;
  for(size_t i=0;i<before.ranges.size();++i){int start=1,end=1;if(FAILED(before.ranges[i]->CompareEndpoints(TextPatternRangeEndpoint_Start,after.ranges[i].Get(),TextPatternRangeEndpoint_Start,&start))||FAILED(before.ranges[i]->CompareEndpoints(TextPatternRangeEndpoint_End,after.ranges[i].Get(),TextPatternRangeEndpoint_End,&end))||start||end)return false;}return true;
}
Status IssueInputProof(Impl* im,Session& s,const WindowPixels& pixels,json& result){
  auto* ss=StateOf(s);if(!ss||!ss->input_lease||!im->input_monitor.Healthy()||!NoHeldInput())return Status::Fail("E_INTERFERENCE_RISK","input proof requires healthy monitoring and released input");
  if(im->input_cancelled->load())return Status::Fail("E_CANCELLED","capture was cancelled");
  if(im->input_monitor.Sequence()!=ss->lease_human_sequence)return Status::Fail("E_INTERFERENCE_RISK","unattributed input retired this interactive lease");
  POINT cursor{};if(!GetCursorPos(&cursor))return Status::Fail("E_INTERFERENCE_RISK","cannot establish cursor identity");
  {SnapshotResult snap;auto status=Snapshot(im,s,snap);if(!status.ok())return status;if(snap.truncated)return Status::Fail("E_RESOURCE_LIMIT","input proof requires a complete tree");ApplySnapshot(s,snap);}
  InputProof proof;
  if(GetForegroundWindow()!=reinterpret_cast<HWND>(static_cast<uintptr_t>(s.hwnd))||FAILED(im->uia->GetFocusedElement(&proof.focused))||!proof.focused)return Status::Fail("E_INTERFERENCE_RISK","interactive proof requires exact foreground and focus");
  auto selection_status=ReadSelection(proof.focused.Get(),proof.selection);if(!selection_status.ok())return selection_status;
  proof.token=NewOpaqueHandle();if(proof.token.empty())return Status::Fail("E_INTERNAL","cannot issue input proof");
  proof.cursor=cursor;proof.bounds=pixels.bounds;proof.tick=GetTickCount64();proof.human_sequence=ss->lease_human_sequence;proof.revision=s.revision;
  // Read-only capture preserves an armed confirmation and its original cursor,
  // focus, selection and sequence. It must never silently re-arm old intent.
  ss->input_proof=proof;result["input_token"]=proof.token;return Status::Ok();
}
bool SelectionMetadata(IUIAutomationElement* element,json& out){
  ComPtr<IUIAutomationTextPattern> pattern;ComPtr<IUIAutomationTextRange> document,prefix,selected;ComPtr<IUIAutomationTextRangeArray> ranges;int count=0;
  if(FAILED(element->GetCurrentPatternAs(UIA_TextPatternId,IID_PPV_ARGS(&pattern)))||!pattern||FAILED(pattern->get_DocumentRange(&document))||!document||FAILED(document->Clone(&prefix))||!prefix||FAILED(pattern->GetSelection(&ranges))||!ranges||FAILED(ranges->get_Length(&count))||count!=1||FAILED(ranges->GetElement(0,&selected))||!selected||FAILED(prefix->MoveEndpointByRange(TextPatternRangeEndpoint_End,selected.Get(),TextPatternRangeEndpoint_Start)))return false;
  BSTR before=nullptr,selection=nullptr;const HRESULT first=prefix->GetText(4097,&before),second=selected->GetText(4097,&selection);const UINT start=before?SysStringLen(before):0,length=selection?SysStringLen(selection):0;
  const bool valid=SUCCEEDED(first)&&SUCCEEDED(second)&&start<=4096&&length<=4096&&start+length<=4096;if(valid)out={{"start",start},{"length",length}};if(before)SysFreeString(before);if(selection)SysFreeString(selection);return valid;
}
bool ExactInputValue(IUIAutomationElement* element,const std::wstring& expected){
  ComPtr<IUIAutomationValuePattern> pattern;if(FAILED(element->GetCurrentPatternAs(UIA_ValuePatternId,IID_PPV_ARGS(&pattern)))||!pattern)return false;
  BSTR value=nullptr;const HRESULT result=pattern->get_CurrentValue(&value);const UINT count=value?SysStringLen(value):0;const bool exact=SUCCEEDED(result)&&count<=4096&&expected.size()==count&&(!count||std::equal(expected.begin(),expected.end(),value));if(value)SysFreeString(value);return exact;
}
bool SelectionCoversDocument(IUIAutomationElement* element,bool caret_at_end=false){
  ComPtr<IUIAutomationTextPattern> pattern;if(FAILED(element->GetCurrentPatternAs(UIA_TextPatternId,IID_PPV_ARGS(&pattern)))||!pattern)return false;
  ComPtr<IUIAutomationTextRange> document;ComPtr<IUIAutomationTextRangeArray> selected;int count=0;
  if(FAILED(pattern->get_DocumentRange(&document))||!document||FAILED(pattern->GetSelection(&selected))||!selected||FAILED(selected->get_Length(&count))||count!=1)return false;
  ComPtr<IUIAutomationTextRange> range;if(FAILED(selected->GetElement(0,&range))||!range)return false;int start=1,end=1;
  if(FAILED(range->CompareEndpoints(TextPatternRangeEndpoint_Start,document.Get(),caret_at_end?TextPatternRangeEndpoint_End:TextPatternRangeEndpoint_Start,&start))||FAILED(range->CompareEndpoints(TextPatternRangeEndpoint_End,document.Get(),TextPatternRangeEndpoint_End,&end)))return false;
  return start==0&&end==0;
}
Status ReadInputElement(Impl* im,Session& s,IUIAutomationElement* element,ElemInfo& out,RECT& bounds,bool& focused,bool& editable){
  (void)im;auto* ss=StateOf(s);int pid=0,type=0;BOOL password=TRUE,enabled=FALSE,focus=FALSE,offscreen=TRUE;
  if(!element||FAILED(element->get_CurrentProcessId(&pid))||static_cast<DWORD>(pid)!=ss->pid||FAILED(element->get_CurrentControlType(&type))||FAILED(element->get_CurrentIsPassword(&password))||FAILED(element->get_CurrentIsEnabled(&enabled))||FAILED(element->get_CurrentHasKeyboardFocus(&focus))||FAILED(element->get_CurrentIsOffscreen(&offscreen))||offscreen||FAILED(element->get_CurrentBoundingRectangle(&bounds))||bounds.right<=bounds.left||bounds.bottom<=bounds.top)return Status::Fail("E_POLICY_DENIED","input target properties cannot be verified");
  if(!TryTextOf(element,&IUIAutomationElement::get_CurrentName,out.name)||!TryTextOf(element,&IUIAutomationElement::get_CurrentAutomationId,out.automation_id))return Status::Fail("E_POLICY_DENIED","input target identity cannot be verified");
  out.role=RoleName(type);out.enabled=enabled!=FALSE;out.is_password=password!=FALSE;out.value=out.is_password?std::string():ValueOf(element);
  out.sensitive=out.is_password||out.value=="[oversize]"||IsSensitiveText(out.name)||IsSensitiveText(out.automation_id)||IsSensitiveText(out.value);
  if(!out.enabled)return Status::Fail("E_POLICY_DENIED","disabled input target");
  if(!im->allow_all&&(out.sensitive||IsBlockedControl(out)))return Status::Fail("E_POLICY_DENIED","sensitive or consequential input target");
  focused=focus!=FALSE;editable=false;ComPtr<IUIAutomationValuePattern> value;
  if(PatternOf(element,UIA_ValuePatternId,value)){BOOL readonly=TRUE;if(FAILED(value->get_CurrentIsReadOnly(&readonly)))return Status::Fail("E_POLICY_DENIED","editable state cannot be verified");editable=!readonly&&out.role=="edit";}
  return Status::Ok();
}
Status SafeInputAncestors(Impl* im,Session& s,IUIAutomationElement* element,bool canvas){
  ComPtr<IUIAutomationTreeWalker> walker;if(FAILED(im->uia->get_RawViewWalker(&walker))||!walker)return Status::Fail("E_POLICY_DENIED","input ancestry cannot be verified");
  ComPtr<IUIAutomationElement> current=element;
  for(int depth=0;depth<64;++depth){
    ElemInfo info;RECT bounds{};bool focused=false,editable=false;auto status=ReadInputElement(im,s,current.Get(),info,bounds,focused,editable);if(!status.ok())return status;
    if(!im->allow_all&&canvas&&info.role!="pane"&&info.role!="group"&&info.role!="document"&&info.role!="unknown"&&info.role!="text"&&info.role!="window")return Status::Fail("E_POLICY_DENIED","gesture ancestry contains an interactive control");
    BOOL root=FALSE;if(FAILED(im->uia->CompareElements(current.Get(),StateOf(s)->root.Get(),&root)))return Status::Fail("E_POLICY_DENIED","input root ancestry cannot be verified");if(root)return Status::Ok();
    ComPtr<IUIAutomationElement> parent;if(FAILED(walker->GetParentElement(current.Get(),&parent))||!parent)return Status::Fail("E_POLICY_DENIED","input target has no verified bound root ancestor");current=parent;
  }
  return Status::Fail("E_RESOURCE_LIMIT","input ancestry exceeds the bounded confirmation contract");
}
Status HitInputTarget(Impl* im,Session& s,POINT point,bool canvas,ComPtr<IUIAutomationElement>& element,ElemInfo& info,RECT& bounds,bool& focused,bool& editable){
  HWND target=reinterpret_cast<HWND>(static_cast<uintptr_t>(s.hwnd));const HWND hit=WindowFromPoint(point);
  if(!hit||GetAncestor(hit,GA_ROOT)!=target)return Status::Fail("E_INTERFERENCE_RISK","point is covered by another native window");
  if(FAILED(im->uia->ElementFromPoint(point,&element))||!element)return Status::Fail("E_POLICY_DENIED","cannot establish the exact UI element at the point");
  auto status=ReadInputElement(im,s,element.Get(),info,bounds,focused,editable);if(!status.ok())return status;
  if(!PtInRect(&bounds,point))return Status::Fail("E_STALE_STATE","point no longer belongs to the hit element");
  return SafeInputAncestors(im,s,element.Get(),canvas);
}
bool SameElement(Impl* im,IUIAutomationElement* a,IUIAutomationElement* b){BOOL same=FALSE;return a&&b&&SUCCEEDED(im->uia->CompareElements(a,b,&same))&&same;}
bool ExactFocus(Impl* im,Session& s,IUIAutomationElement* wanted){
  HWND target=reinterpret_cast<HWND>(static_cast<uintptr_t>(s.hwnd));GUITHREADINFO gui{};gui.cbSize=sizeof gui;
  const auto thread=GetWindowThreadProcessId(target,nullptr);if(!thread||!GetGUIThreadInfo(thread,&gui)||!gui.hwndFocus||(gui.hwndFocus!=target&&!IsChild(target,gui.hwndFocus)))return false;
  ComPtr<IUIAutomationElement> focused;return SUCCEEDED(im->uia->GetFocusedElement(&focused))&&SameElement(im,wanted,focused.Get());
}
struct PhysicalInput {
  Impl* im;Session* session;InputProof proof;POINT cursor{};bool cursor_known=false,left=false,ctrl=false,a=false,back=false,may=false,released=true,check_selection=true;DWORD owned_bits=0;std::vector<WORD> unicode_owned;Status arm_failure;
  PhysicalInput(Impl* owner,Session& s,const InputProof& p):im(owner),session(&s),proof(p){cursor=proof.cursor;cursor_known=true;}
  Status Fail(const char* code,const char* message){return arm_failure.ok()?Status::Fail(code,message,may):Status::Fail(arm_failure.code,arm_failure.message,may);}
  Status Guard(bool check_focus=true){
    if(im->input_cancelled->load())return Fail("E_CANCELLED","physical input cancelled");
    if(!may&&proof.tick&&GetTickCount64()-proof.tick>5000)return Fail("E_STALE_STATE","input proof expired before the first physical event");
    if(!im->input_monitor.Healthy()||im->input_monitor.Sequence()!=proof.human_sequence)return Fail("E_INTERFERENCE_RISK","unattributed human or injected input invalidated the proof");
    auto status=Revalidate(im,*session);if(!status.ok())return Status::Fail(status.code,status.message,may);
    const HWND target=reinterpret_cast<HWND>(static_cast<uintptr_t>(session->hwnd));
    if(GetForegroundWindow()!=target)return Fail("E_INTERFERENCE_RISK","target is not the exact foreground window");
    RECT bounds{};if(FAILED(DwmGetWindowAttribute(target,DWMWA_EXTENDED_FRAME_BOUNDS,&bounds,sizeof bounds))||!EqualRect(&bounds,&proof.bounds))return Fail("E_STALE_STATE","window geometry changed after observation");
    if(check_focus&&(!proof.focused||!ExactFocus(im,*session,proof.focused.Get())))return Fail("E_INTERFERENCE_RISK","keyboard focus changed outside the validated input sequence");
    if(check_focus&&check_selection&&!SameSelection(proof.focused.Get(),proof.selection))return Fail("E_STALE_STATE","caret or text selection changed after observation");
    for(int key=1;key<256;++key)if((GetAsyncKeyState(key)&0x8000)&&!(left&&key==VK_LBUTTON)&&!(ctrl&&(key==VK_CONTROL||key==VK_LCONTROL))&&!(a&&key=='A')&&!(back&&key==VK_BACK)&&!((owned_bits&InputOwnership::Unicode)&&key==VK_PACKET))return Fail("E_INTERFERENCE_RISK","another input is held");
    POINT now{};if(!cursor_known||!GetCursorPos(&now)||now.x!=cursor.x||now.y!=cursor.y)return Fail("E_INTERFERENCE_RISK","cursor moved outside the input sequence");
    return Status::Ok();
  }
  bool Own(DWORD bits,const std::vector<WORD>& units={}){auto* state=StateOf(*session);if(!state||!state->input_lease||!state->input_lease->Journal().Set(bits,units))return false;owned_bits=bits;unicode_owned=units;return true;}
  bool Arm(DWORD bits,const std::vector<WORD>& units={}){
    if(!Own(bits,units))return false;auto status=Guard();if(status.ok())return true;
    // No down has been dispatched for this record. Do not send an up for
    // somebody else's newly held input when cancelling during journal I/O.
    if(Own(0)){left=ctrl=a=back=false;}arm_failure=status;return false;
  }
  bool Send(INPUT* inputs,UINT count){for(UINT i=0;i<count;++i)if(inputs[i].type==INPUT_MOUSE)inputs[i].mi.dwExtraInfo=im->input_monitor.Tag();else inputs[i].ki.dwExtraInfo=im->input_monitor.Tag();const auto before=im->input_monitor.OwnSequence();may=true;const UINT sent=SendInput(count,inputs,sizeof(INPUT));const bool observed=im->input_monitor.AwaitOwn(before+sent);return sent==count&&observed;}
  INPUT Mouse(DWORD flags,LONG data=0){INPUT input{};input.type=INPUT_MOUSE;input.mi.dwFlags=flags;input.mi.mouseData=data;return input;}
  INPUT Key(WORD key,bool up=false,bool unicode=false){INPUT input{};input.type=INPUT_KEYBOARD;input.ki.wVk=unicode?0:key;input.ki.wScan=unicode?key:0;input.ki.dwFlags=(up?KEYEVENTF_KEYUP:0)|(unicode?KEYEVENTF_UNICODE:0);return input;}
  Status Move(POINT point){auto status=Guard();if(!status.ok())return status;
    const int x=GetSystemMetrics(SM_XVIRTUALSCREEN),y=GetSystemMetrics(SM_YVIRTUALSCREEN),w=GetSystemMetrics(SM_CXVIRTUALSCREEN),h=GetSystemMetrics(SM_CYVIRTUALSCREEN);
    if(w<=1||h<=1||point.x<x||point.y<y||point.x>=x+w||point.y>=y+h)return Fail("E_INTERFERENCE_RISK","point is outside the current virtual desktop");
    INPUT move=Mouse(MOUSEEVENTF_MOVE|MOUSEEVENTF_ABSOLUTE|MOUSEEVENTF_VIRTUALDESK|MOUSEEVENTF_MOVE_NOCOALESCE);
    move.mi.dx=static_cast<LONG>(((2LL*(point.x-x)+1)*65536)/(2LL*w));move.mi.dy=static_cast<LONG>(((2LL*(point.y-y)+1)*65536)/(2LL*h));
    if(!Send(&move,1))return Fail("E_ACTION_FAILED","mouse move injection failed");
    for(int tries=0;tries<20;++tries){POINT actual{};if(GetCursorPos(&actual)&&actual.x==point.x&&actual.y==point.y){cursor=actual;return Guard();}Sleep(2);}
    return Fail("E_INTERFERENCE_RISK","mouse did not reach the validated point");
  }
  bool DisarmReleased(){
    bool held=true;for(int n=0;n<50;++n){held=false;if(owned_bits&InputOwnership::Left)held|=(GetAsyncKeyState(VK_LBUTTON)&0x8000)!=0;if(owned_bits&InputOwnership::Ctrl)held|=(GetAsyncKeyState(VK_CONTROL)&0x8000)!=0;if(owned_bits&InputOwnership::A)held|=(GetAsyncKeyState('A')&0x8000)!=0;if(owned_bits&InputOwnership::Back)held|=(GetAsyncKeyState(VK_BACK)&0x8000)!=0;if(!held)break;Sleep(2);}
    if(held||!Own(0)){released=false;return false;}left=ctrl=a=back=false;released=true;return true;
  }
  bool Release(){
    if(!owned_bits){released=true;return true;}
    std::vector<INPUT> ups;if(owned_bits&InputOwnership::Left)ups.push_back(Mouse(MOUSEEVENTF_LEFTUP));if(owned_bits&InputOwnership::A)ups.push_back(Key('A',true));if(owned_bits&InputOwnership::Ctrl)ups.push_back(Key(VK_CONTROL,true));if(owned_bits&InputOwnership::Back)ups.push_back(Key(VK_BACK,true));if(owned_bits&InputOwnership::Unicode)for(WORD unit:unicode_owned)ups.push_back(Key(unit,true,true));
    if(!Send(ups.data(),static_cast<UINT>(ups.size()))){released=false;return false;}return DisarmReleased();
  }
  Status WaitFocus(IUIAutomationElement* target){
    for(int attempt=0;attempt<40;++attempt){auto status=Guard(false);if(!status.ok())return status;if(ExactFocus(im,*session,target)){proof.focused=target;auto selection=ReadSelection(target,proof.selection);if(!selection.ok())return Fail(selection.code,selection.message.c_str());return Guard();}Sleep(5);}
    return Fail("E_INTERFERENCE_RISK","pointer input did not focus the exact validated target");
  }
  template<typename VerifyTarget>Status Click(IUIAutomationElement* target,VerifyTarget verify_target){auto status=Guard();if(!status.ok())return status;INPUT inputs[2]={Mouse(MOUSEEVENTF_LEFTDOWN),Mouse(MOUSEEVENTF_LEFTUP)};if(!Arm(InputOwnership::Left))return Fail("E_ACTION_FAILED","cannot persist owned mouse state");status=verify_target();if(!status.ok()){Own(0);return status;}check_selection=false;left=true;if(!Send(inputs,2))return Fail("E_ACTION_FAILED","mouse click injection failed");if(!DisarmReleased())return Fail("E_ACTION_FAILED","cannot verify click input release");return WaitFocus(target);}
  ~PhysicalInput(){Release();}
};
Status ValidateProof(Impl* im,Session& s,const std::string& token,InputProof& proof){
  auto* ss=StateOf(s);if(!ss||!ss->input_lease||!im->interactive_enabled||s.mode!="interactive_desktop")return Status::Fail("E_POLICY_DENIED","physical input requires the interactive lease");
  proof=ss->input_proof;if(token.empty()||token!=proof.token||GetTickCount64()-proof.tick>5000)return Status::Fail("E_STALE_STATE","input proof is stale or no longer current");
  SnapshotResult fresh;auto status=Snapshot(im,s,fresh);if(!status.ok())return status;if(fresh.truncated)return Status::Fail("E_RESOURCE_LIMIT","input validation requires a complete native tree");ApplySnapshot(s,fresh);
  if(proof.revision!=s.revision)return Status::Fail("E_STALE_STATE","native semantic state changed after capture");return Status::Ok();
}
bool SourcePoint(const json& value,const RECT& bounds,POINT& point){
  if(!value.is_object()||!value.contains("x")||!value.contains("y")||!value["x"].is_number()||!value["y"].is_number())return false;
  const double x=value["x"].get<double>(),y=value["y"].get<double>();
  if(!std::isfinite(x)||!std::isfinite(y)||x<0||y<0||x>=bounds.right-bounds.left||y>=bounds.bottom-bounds.top)return false;
  point={bounds.left+static_cast<LONG>(std::floor(x)),bounds.top+static_cast<LONG>(std::floor(y))};return true;
}
Status FreshConfirmationTarget(PhysicalInput& input,InputConfirmation& confirmation,ElemInfo& info,bool require_focus=false){
  auto status=input.Guard();if(!status.ok())return status;ComPtr<IUIAutomationElement> hit;RECT bounds{};bool focused=false,editable=false;
  status=HitInputTarget(input.im,*input.session,confirmation.point,false,hit,info,bounds,focused,editable);if(!status.ok())return Status::Fail(status.code,status.message,input.may);
  if(!SameElement(input.im,confirmation.element.Get(),hit.Get())||!EqualRect(&bounds,&confirmation.element_bounds)||ElementFingerprint(info)!=confirmation.fingerprint||!SameSelection(hit.Get(),confirmation.target_selection))return input.Fail("E_STALE_STATE","confirmed input target changed");
  if(require_focus&&!ExactFocus(input.im,*input.session,confirmation.element.Get()))return input.Fail("E_INTERFERENCE_RISK","keyboard focus is not the exact confirmed element");return Status::Ok();
}
Status PrepareInput(Impl* im,Session& s,const json& doc,const ControlsTable& controls,json& out){
  if(!ExactFields(doc,{"op","request_id","target_id","session_id","input_token","point","action","expected_target"})||!doc.contains("input_token")||!doc["input_token"].is_string()||!doc.contains("action")||!doc["action"].is_string()||!doc.contains("point")||!ExactFields(doc["point"],{"x","y"}))return Status::Fail("E_BAD_REQUEST","invalid prepare input fields");
  const auto action=doc["action"].get<std::string>();if(action!="click"&&action!="fill")return Status::Fail("E_BAD_REQUEST","prepare supports click or fill only");
  InputProof proof;auto status=ValidateProof(im,s,doc["input_token"].get<std::string>(),proof);if(!status.ok())return status;
  POINT point{};if(!SourcePoint(doc["point"],proof.bounds,point))return Status::Fail("E_BAD_REQUEST","point is outside the captured source");
  PhysicalInput input(im,s,proof);status=input.Guard();if(!status.ok())return status;
  ComPtr<IUIAutomationElement> element;ElemInfo info;RECT bounds{};bool focused=false,editable=false;
  status=HitInputTarget(im,s,point,false,element,info,bounds,focused,editable);if(!status.ok())return status;
  if((!controls.allow_all&&(!ActionAllowed(controls,info.automation_id,action)||ExpectedRole(controls,info.automation_id)!=info.role))||(action=="fill"&&!editable))return Status::Fail("E_POLICY_DENIED","target does not match the trusted control/action/role contract");
  status=VerifyUniqueLiveElement(im,StateOf(s),element.Get(),info.automation_id,info.role);if(!status.ok())return status;
  if(doc.contains("expected_target")){
    const auto& expected=doc["expected_target"];if(!expected.is_object()||!ExactFields(expected,{"role","name"})||expected.empty())return Status::Fail("E_BAD_REQUEST","invalid target expectation");
    if((expected.contains("role")&&(!expected["role"].is_string()||expected["role"].get<std::string>()!=PublicRole(info.role)))||(expected.contains("name")&&(!expected["name"].is_string()||expected["name"].get<std::string>()!=info.name)))return Status::Fail("E_STALE_STATE","target does not match the expected role/name");
  }
  InputConfirmation confirmation;confirmation.id=NewOpaqueHandle();if(confirmation.id.empty())return Status::Fail("E_INTERNAL","cannot issue confirmation");
  confirmation.action=action;confirmation.element=element;confirmation.element_bounds=bounds;confirmation.bounds=proof.bounds;confirmation.point=point;confirmation.automation_id=info.automation_id;confirmation.role=info.role;confirmation.name=info.name;confirmation.fingerprint=ElementFingerprint(info);confirmation.editable=editable;confirmation.focused_before=proof.focused;confirmation.focused_selection=proof.selection;
  status=ReadSelection(element.Get(),confirmation.target_selection);if(!status.ok())return status;if(action=="fill"&&!confirmation.target_selection.supported)return Status::Fail("E_UNSUPPORTED_ACTION","physical fill requires a provider with verifiable text selection");
  status=input.Move(point);if(!status.ok())return status;Sleep(60);
  ElemInfo after;status=FreshConfirmationTarget(input,confirmation,after);if(!status.ok())return status;
  confirmation.expires=GetTickCount64()+30000;confirmation.human_sequence=im->input_monitor.Sequence();StateOf(s)->confirmation=confirmation;
  const bool focus_matches=ExactFocus(im,s,element.Get());
  out={{"confirmation_id",confirmation.id},{"expires_in_ms",30000},{"action",action},{"target",{{"role",PublicRole(info.role)},{"name",info.name},{"enabled",true},{"focused",focus_matches},{"editable",editable}}},{"pointer_on_target",true},{"focus_matches_target",focus_matches}};json selection;if(SelectionMetadata(element.Get(),selection))out["target"]["selection"]=selection;return Status::Ok();
}
Status CommitInput(Impl* im,Session& s,const json& doc,const ControlsTable& controls,json& out){
  (void)controls;if(!ExactFields(doc,{"op","request_id","target_id","session_id","confirmation_id","value"})||!doc.contains("confirmation_id")||!doc["confirmation_id"].is_string())return Status::Fail("E_BAD_REQUEST","invalid commit input fields");
  auto* ss=StateOf(s);InputConfirmation confirmation=ss->confirmation;ss->confirmation=InputConfirmation{};ss->input_proof=InputProof{};
  if(confirmation.id.empty()||confirmation.id!=doc["confirmation_id"].get<std::string>()||GetTickCount64()>confirmation.expires)return Status::Fail("E_STALE_STATE","confirmation is stale, foreign or already consumed");
  std::wstring value;if(confirmation.action=="fill"){
    if(!doc.contains("value")||!doc["value"].is_string()||doc["value"].get<std::string>().size()>4096)return Status::Fail("E_BAD_REQUEST","fill requires bounded plain text");
    value=ToWide(doc["value"].get<std::string>());if(value.empty()&&!doc["value"].get<std::string>().empty())return Status::Fail("E_BAD_REQUEST","invalid fill text");
    for(wchar_t c:value)if(c<0x20||(c>=0x7f&&c<=0x9f)||c==0x2028||c==0x2029)return Status::Fail("E_BAD_REQUEST","control characters are not permitted in physical fill");
  }else if(doc.contains("value"))return Status::Fail("E_BAD_REQUEST","click cannot carry a fill value");
  InputProof proof;proof.bounds=confirmation.bounds;proof.human_sequence=confirmation.human_sequence;proof.focused=confirmation.focused_before;proof.selection=confirmation.focused_selection;PhysicalInput input(im,s,proof);input.cursor=confirmation.point;input.cursor_known=true;
  ElemInfo info;auto status=FreshConfirmationTarget(input,confirmation,info);if(!status.ok())return status;
  auto verify_click_target=[&](){ElemInfo current;return FreshConfirmationTarget(input,confirmation,current);};
  if(confirmation.action=="click")status=input.Click(confirmation.element.Get(),verify_click_target);
  else {
    if(!ExactFocus(im,s,confirmation.element.Get())){status=input.Click(confirmation.element.Get(),verify_click_target);if(!status.ok())return status;for(int i=0;i<40&&!ExactFocus(im,s,confirmation.element.Get());++i){status=input.Guard();if(!status.ok())return status;Sleep(5);}}
    if(!ExactFocus(im,s,confirmation.element.Get()))return input.Fail("E_INTERFERENCE_RISK","validated click did not focus the exact editable target");
    status=input.Guard();if(!status.ok())return status;
    RECT bounds{};bool focused=false,editable=false;ElemInfo editable_info;status=ReadInputElement(im,s,confirmation.element.Get(),editable_info,bounds,focused,editable);
    if(!status.ok()||!editable||!EqualRect(&bounds,&confirmation.element_bounds))return input.Fail("E_POLICY_DENIED","confirmed field is no longer editable");
    const auto original_value=ToWide(editable_info.value);
    auto verify_replacement=[&](const std::wstring& expected,bool full_selection)->Status{
      auto checked=input.Guard();if(!checked.ok())return checked;
      ComPtr<IUIAutomationElement> hit;ElemInfo live;RECT live_bounds{};bool live_focused=false,live_editable=false;
      checked=HitInputTarget(im,s,confirmation.point,false,hit,live,live_bounds,live_focused,live_editable);
      if(!checked.ok())return Status::Fail(checked.code,checked.message,input.may);
      if(!SameElement(im,hit.Get(),confirmation.element.Get())||!live_editable||!EqualRect(&live_bounds,&confirmation.element_bounds)||live.automation_id!=confirmation.automation_id||live.role!=confirmation.role||live.name!=confirmation.name)return input.Fail("E_STALE_STATE","editable hit identity, ancestry or geometry changed before replacement");
      if(!ExactFocus(im,s,confirmation.element.Get()))return input.Fail("E_INTERFERENCE_RISK","focus changed before replacement");
      if(!ExactInputValue(confirmation.element.Get(),expected)||!SelectionCoversDocument(confirmation.element.Get(),!full_selection))return input.Fail("E_STALE_STATE","editable value, caret or selection changed before replacement");
      return Status::Ok();
    };
    INPUT select[4]={input.Key(VK_CONTROL),input.Key('A'),input.Key('A',true),input.Key(VK_CONTROL,true)};if(!input.Arm(InputOwnership::Ctrl|InputOwnership::A))return input.Fail("E_ACTION_FAILED","cannot persist owned selection keys");
    {ComPtr<IUIAutomationElement> selection_hit;ElemInfo selection_info;RECT selection_bounds{};bool selection_focus=false,selection_editable=false;status=HitInputTarget(im,s,confirmation.point,false,selection_hit,selection_info,selection_bounds,selection_focus,selection_editable);if(!status.ok()||!SameElement(im,selection_hit.Get(),confirmation.element.Get())||!selection_editable||!EqualRect(&selection_bounds,&confirmation.element_bounds)||selection_info.automation_id!=confirmation.automation_id||selection_info.role!=confirmation.role||selection_info.name!=confirmation.name||!ExactInputValue(confirmation.element.Get(),original_value)){input.Own(0);return status.ok()?input.Fail("E_STALE_STATE","editable target changed before selection"):Status::Fail(status.code,status.message,input.may);}status=input.Guard();if(!status.ok()){input.Own(0);return status;}}
    input.check_selection=false;input.ctrl=input.a=true;
    if(!input.Send(select,4))return input.Fail("E_ACTION_FAILED","text selection injection failed");if(!input.DisarmReleased())return input.Fail("E_ACTION_FAILED","cannot verify selection key release");
    bool all_selected=false;for(int n=0;n<50;++n){status=input.Guard();if(!status.ok())return status;if(SelectionCoversDocument(confirmation.element.Get())){all_selected=true;break;}Sleep(4);}
    if(!all_selected)return input.Fail("E_ACTION_FAILED","full text selection could not be verified before replacement");
    if(value.empty()) {
      status=verify_replacement(original_value,true);if(!status.ok())return status;
      if(!input.Arm(InputOwnership::Back))return input.Fail("E_ACTION_FAILED","cannot persist owned erase key");
      status=verify_replacement(original_value,true);if(!status.ok()){input.Own(0);return status;}
      input.back=true;INPUT erase[2]={input.Key(VK_BACK),input.Key(VK_BACK,true)};if(!input.Send(erase,2))return input.Fail("E_ACTION_FAILED","empty text replacement failed");if(!input.DisarmReleased())return input.Fail("E_ACTION_FAILED","cannot verify erase key release");
    }
    for(size_t i=0;i<value.size();){status=input.Guard();if(!status.ok())return status;
      if(!ExactFocus(im,s,confirmation.element.Get()))return input.Fail("E_INTERFERENCE_RISK","focus changed before a text input chunk");
      RECT current{};bool now_focused=false,now_editable=false;ElemInfo current_info;
      auto current_status=ReadInputElement(im,s,confirmation.element.Get(),current_info,current,now_focused,now_editable);
      if(!current_status.ok()||!now_editable||!EqualRect(&current,&confirmation.element_bounds)||current_info.automation_id!=confirmation.automation_id||current_info.role!=confirmation.role||current_info.name!=confirmation.name)return input.Fail("E_STALE_STATE","editable target identity, geometry or state changed");
      status=verify_replacement(i?value.substr(0,i):original_value,i==0);if(!status.ok())return status;
      std::vector<INPUT> text;auto end=std::min(value.size(),i+16);if(end<value.size()&&value[end-1]>=0xd800&&value[end-1]<=0xdbff)--end;
      std::vector<WORD> units;for(size_t j=i;j<end;++j)units.push_back(static_cast<WORD>(value[j]));
      if(!input.Arm(InputOwnership::Unicode,units))return input.Fail("E_ACTION_FAILED","cannot persist owned Unicode input");
      status=verify_replacement(i?value.substr(0,i):original_value,i==0);if(!status.ok()){input.Own(0);return status;}
      for(size_t j=i;j<end;++j){text.push_back(input.Key(static_cast<WORD>(value[j]),false,true));text.push_back(input.Key(static_cast<WORD>(value[j]),true,true));}
      if(!input.Send(text.data(),static_cast<UINT>(text.size()))){input.Release();return input.Fail("E_ACTION_FAILED","plain text injection failed");}
      if(!input.DisarmReleased())return input.Fail("E_ACTION_FAILED","cannot verify Unicode input release");
      bool exact=false;for(int n=0;n<50;++n){status=input.Guard();if(!status.ok())return status;if(ExactInputValue(confirmation.element.Get(),value.substr(0,end))&&SelectionCoversDocument(confirmation.element.Get(),true)){exact=true;break;}Sleep(4);}
      if(!exact)return input.Fail("E_ACTION_FAILED","text replacement or caret position did not match the intended prefix");i=end;
    }
    bool value_exact=false;for(int n=0;n<50;++n){status=input.Guard();if(!status.ok())return status;if(ExactInputValue(confirmation.element.Get(),value)){value_exact=true;break;}Sleep(4);}
    if(!value_exact)return input.Fail("E_ACTION_FAILED","text replacement did not match the intended value");
    status=input.Guard();if(status.ok()&&!ExactFocus(im,s,confirmation.element.Get()))status=input.Fail("E_INTERFERENCE_RISK","focus changed during text input");
  }
  if(!status.ok())return status;if(!input.Release())return input.Fail("E_ACTION_FAILED","could not release owned input");
  out={{"released_input",true},{"verified","input_sequence_completed"},{"action",confirmation.action}};return Status::Ok();
}
Status GestureInput(Impl* im,Session& s,const json& doc,json& out){
  if(!ExactFields(doc,{"op","request_id","target_id","session_id","expected_revision","input_token","surface_id","kind","points","swipe_backend"})||!doc.contains("input_token")||!doc["input_token"].is_string()||!doc.contains("surface_id")||!doc["surface_id"].is_string()||!doc.contains("kind")||!doc["kind"].is_string()||!doc.contains("expected_revision")||!doc["expected_revision"].is_number_integer()||!doc.contains("points")||!doc["points"].is_array()||doc["points"].size()<2||doc["points"].size()>64)return Status::Fail("E_BAD_REQUEST","invalid gesture fields");
  const auto kind=doc["kind"].get<std::string>();if(kind!="drag"&&kind!="swipe")return Status::Fail("E_BAD_REQUEST","unknown gesture kind");
  const InputSurface* surface=nullptr;for(const auto& candidate:im->input_surfaces)if(candidate.id==doc["surface_id"].get<std::string>())surface=&candidate;
  if(!surface||(kind=="drag"&&!surface->drag)||(kind=="swipe"&&!surface->swipe))return Status::Fail("E_POLICY_DENIED","gesture surface/kind was not explicitly allowed");
  if(kind=="swipe"&&(surface->swipe_backend!="scroll"||!doc.contains("swipe_backend")||!doc["swipe_backend"].is_string()||doc["swipe_backend"].get<std::string>()!="scroll"))return Status::Fail("E_UNSUPPORTED_ACTION","only provenance-safe native scroll swipe is available");
  if(kind=="drag"&&doc.contains("swipe_backend"))return Status::Fail("E_BAD_REQUEST","drag cannot select a swipe backend");
  InputProof proof;auto status=ValidateProof(im,s,doc["input_token"].get<std::string>(),proof);if(!status.ok())return status;
  if(doc["expected_revision"].get<long long>()!=s.revision)return Status::Fail("E_STALE_STATE","native gesture revision is stale");
  std::vector<std::pair<POINT,unsigned>> points;int prior=-1;bool moved=false;
  for(const auto& point:doc["points"]){POINT physical{};if(!point.is_object()||!ExactFields(point,{"x","y","t_ms"})||!point.contains("t_ms")||!point["t_ms"].is_number_integer()||!SourcePoint(point,proof.bounds,physical))return Status::Fail("E_BAD_REQUEST","invalid source gesture point");
    if(point["t_ms"]<0||point["t_ms"]>5000)return Status::Fail("E_BAD_REQUEST","gesture time exceeds the bounded input contract");
    const int time=point["t_ms"].get<int>();POINT source{physical.x-proof.bounds.left,physical.y-proof.bounds.top};
    if(time<0||time>5000||(prior<0?time!=0:time<=prior)||!PtInRect(&surface->region,source))return Status::Fail("E_BAD_REQUEST","gesture points exceed the trusted surface or time bounds");
    if(!points.empty()&&(physical.x!=points[0].first.x||physical.y!=points[0].first.y))moved=true;points.emplace_back(physical,static_cast<unsigned>(time));prior=time;
  }
  if(!moved)return Status::Fail("E_BAD_REQUEST","gesture requires a nonzero physical path");
  StateOf(s)->input_proof=InputProof{};StateOf(s)->confirmation=InputConfirmation{};PhysicalInput input(im,s,proof);
  // Validate every planned hit before emitting any input, then repeat each hit
  // immediately before dispatch because application content can still change.
  for(const auto& point:points){status=input.Guard();if(!status.ok())return status;ComPtr<IUIAutomationElement> hit;ElemInfo info;RECT bounds{};bool focused=false,editable=false;status=HitInputTarget(im,s,point.first,true,hit,info,bounds,focused,editable);if(!status.ok())return status;}
  const auto start=GetTickCount64();
  for(size_t i=0;i<points.size();++i){
    while(GetTickCount64()-start<points[i].second){status=input.Guard();if(!status.ok())return status;Sleep(2);}
    status=input.Guard();if(!status.ok())return status;ComPtr<IUIAutomationElement> hit;ElemInfo info;RECT bounds{};bool focused=false,editable=false;
    status=HitInputTarget(im,s,points[i].first,true,hit,info,bounds,focused,editable);if(!status.ok())return Status::Fail(status.code,status.message,input.may);
    if(kind=="drag"||i==0){status=input.Move(points[i].first);if(!status.ok())return status;}
    ComPtr<IUIAutomationElement> current_hit;ElemInfo current_info;RECT current_bounds{};bool current_focused=false,current_editable=false;
    status=HitInputTarget(im,s,input.cursor,true,current_hit,current_info,current_bounds,current_focused,current_editable);
    if(!status.ok())return Status::Fail(status.code,status.message,input.may);
    if(kind=="swipe"&&!ExactFocus(im,s,current_hit.Get()))return input.Fail("E_INTERFERENCE_RISK","scroll swipe requires the exact focused canvas");
    if(i==0&&kind=="drag"){auto down=input.Mouse(MOUSEEVENTF_LEFTDOWN);if(!input.Arm(InputOwnership::Left))return input.Fail("E_ACTION_FAILED","cannot persist owned drag state");ComPtr<IUIAutomationElement> final_hit;ElemInfo final_info;RECT final_bounds{};bool final_focused=false,final_editable=false;status=HitInputTarget(im,s,input.cursor,true,final_hit,final_info,final_bounds,final_focused,final_editable);if(!status.ok()||!SameElement(im,current_hit.Get(),final_hit.Get())||!EqualRect(&current_bounds,&final_bounds)||ElementFingerprint(current_info)!=ElementFingerprint(final_info)){input.Own(0);return status.ok()?input.Fail("E_STALE_STATE","gesture start hit changed before press"):Status::Fail(status.code,status.message,input.may);}input.check_selection=false;input.left=true;if(!input.Send(&down,1))return input.Fail("E_ACTION_FAILED","drag press failed");status=input.WaitFocus(current_hit.Get());if(!status.ok())return status;}
    if(i>0&&kind=="swipe"){
      const LONG delta=points[i-1].first.y-points[i].first.y;const LONG horizontal=points[i].first.x-points[i-1].first.x;
      if(delta){auto wheel=input.Mouse(MOUSEEVENTF_WHEEL,std::clamp<LONG>(delta*3,-1200,1200));if(!input.Send(&wheel,1))return input.Fail("E_ACTION_FAILED","scroll swipe injection failed");}
      if(horizontal){auto wheel=input.Mouse(MOUSEEVENTF_HWHEEL,std::clamp<LONG>(horizontal*3,-1200,1200));if(!input.Send(&wheel,1))return input.Fail("E_ACTION_FAILED","horizontal scroll swipe injection failed");}
    }
  }
  if(!input.Release())return input.Fail("E_ACTION_FAILED","could not release gesture input");status=input.Guard();if(!status.ok())return status;
  out={{"released_input",true},{"verified","input_sequence_completed"},{"kind",kind},{"points_executed",points.size()},{"backend",kind=="drag"?"mouse_drag":"scroll_swipe"}};return Status::Ok();
}
Status InputOperation(void* ctx,Session& s,const json& doc,const ControlsTable& controls,json& out){
  auto* im=static_cast<Impl*>(ctx);if(!im->interactive_enabled||s.mode!="interactive_desktop"||!StateOf(s)->input_lease)return Status::Fail("E_POLICY_DENIED","interactive physical input is unavailable");
  const auto op=doc["op"].get<std::string>();if(op=="prepare_input")return PrepareInput(im,s,doc,controls,out);if(op=="commit_input")return CommitInput(im,s,doc,controls,out);if(op=="gesture")return GestureInput(im,s,doc,out);return Status::Fail("E_BAD_REQUEST","unknown physical input operation");
}
