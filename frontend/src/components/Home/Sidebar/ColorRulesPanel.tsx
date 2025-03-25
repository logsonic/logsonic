import { useState } from "react";
import { Plus, Trash2, X, Pencil, Check, AlertCircle, Palette } from "lucide-react";
import { Card, CardContent } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Badge } from "@/components/ui/badge";
import { Label } from "@/components/ui/label";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { Switch } from "@/components/ui/switch";
import { ColorRule, useColorRuleStore } from "@/stores/useColorRuleStore";
import { useSearchQueryParamsStore } from "@/stores/useSearchParams";
import { useLogResultStore } from "@/stores/useLogResultStore";
import { cn } from "@/lib/utils";
import { ScrollArea } from "@/components/ui/scroll-area";
import { Tooltip, TooltipContent, TooltipProvider, TooltipTrigger } from "@/components/ui/tooltip";
import { Popover, PopoverContent, PopoverTrigger } from "@/components/ui/popover";
import { Collapsible, CollapsibleContent, CollapsibleTrigger } from "@/components/ui/collapsible";

// Enhanced colors with better distinction and proper names
const ENHANCED_COLORS = [
  // Light colors
  { name: 'Blue', value: 'bg-blue-100', textColor: 'text-blue-800' },
  { name: 'Green', value: 'bg-green-100', textColor: 'text-green-800' },
  { name: 'Yellow', value: 'bg-yellow-100', textColor: 'text-yellow-800' },
  { name: 'Red', value: 'bg-red-100', textColor: 'text-red-800' },
  { name: 'Purple', value: 'bg-purple-100', textColor: 'text-purple-800' },
  { name: 'Pink', value: 'bg-pink-100', textColor: 'text-pink-800' },
  { name: 'Indigo', value: 'bg-indigo-100', textColor: 'text-indigo-800' },
  { name: 'Amber', value: 'bg-amber-100', textColor: 'text-amber-800' },
  { name: 'Lime', value: 'bg-lime-100', textColor: 'text-lime-800' },
  { name: 'Teal', value: 'bg-teal-100', textColor: 'text-teal-800' },
  { name: 'Cyan', value: 'bg-cyan-100', textColor: 'text-cyan-800' },
  { name: 'Orange', value: 'bg-orange-100', textColor: 'text-orange-800' },
  // Medium colors
  { name: 'Blue Mid', value: 'bg-blue-200', textColor: 'text-blue-800' },
  { name: 'Green Mid', value: 'bg-green-200', textColor: 'text-green-800' },
  { name: 'Yellow Mid', value: 'bg-yellow-200', textColor: 'text-yellow-800' },
  { name: 'Red Mid', value: 'bg-red-200', textColor: 'text-red-800' },
  { name: 'Purple Mid', value: 'bg-purple-200', textColor: 'text-purple-800' },
  { name: 'Pink Mid', value: 'bg-pink-200', textColor: 'text-pink-800' },
  // Grayscale colors
  { name: 'Stone', value: 'bg-stone-100', textColor: 'text-stone-800' },
  { name: 'Zinc', value: 'bg-zinc-100', textColor: 'text-zinc-800' },
  { name: 'Slate', value: 'bg-slate-100', textColor: 'text-slate-800' },
  { name: 'Gray', value: 'bg-gray-100', textColor: 'text-gray-800' },
  // Vibrant colors
  { name: 'Fuchsia', value: 'bg-fuchsia-100', textColor: 'text-fuchsia-800' },
  { name: 'Rose', value: 'bg-rose-100', textColor: 'text-rose-800' },
  { name: 'Sky', value: 'bg-sky-100', textColor: 'text-sky-800' },
  { name: 'Emerald', value: 'bg-emerald-100', textColor: 'text-emerald-800' },
  { name: 'Violet', value: 'bg-violet-100', textColor: 'text-violet-800' },
];

// Color picker component for reuse
const ColorPicker = ({ selectedColor, onColorSelect }) => (
  <div className="grid grid-cols-4 gap-1.5 p-1">
    {ENHANCED_COLORS.map((color, index) => (
      <Tooltip key={`${color.value}-${index}`}>
        <TooltipTrigger asChild>
          <button
            type="button"
            className={cn(
              "w-6 h-6 rounded-sm border transition-all flex items-center justify-center",
              color.value,
              selectedColor === color.value 
                ? "ring-2 ring-primary ring-offset-1 scale-110" 
                : "hover:scale-105 hover:ring-1 hover:ring-slate-300"
            )}
            onClick={() => onColorSelect(color.value)}
          >
            {selectedColor === color.value && (
              <Check className={cn("h-3 w-3", color.textColor)} />
            )}
          </button>
        </TooltipTrigger>
        <TooltipContent side="bottom" className="py-1 px-2 text-xs">
          {color.name}
        </TooltipContent>
      </Tooltip>
    ))}
  </div>
);

export const ColorRulesPanel = () => {
  const [isAddPanelOpen, setIsAddPanelOpen] = useState(false);
  const [newRule, setNewRule] = useState<Omit<ColorRule, "id">>({
    field: "",
    operator: "eq",
    value: "",
    color: ENHANCED_COLORS[0].value,
    enabled: true,
  });
  
  // Track the rule being edited
  const [editingRuleId, setEditingRuleId] = useState<string | null>(null);
  const [editingRule, setEditingRule] = useState<Omit<ColorRule, "id">>({
    field: "",
    operator: "eq",
    value: "",
    color: ENHANCED_COLORS[0].value,
    enabled: true,
  });

  const { colorRules, addRule, updateRule, deleteRule, toggleRule } = useColorRuleStore();
  const { logData } = useLogResultStore();
  const { selectedColumns } = useSearchQueryParamsStore();

  // Combine selected columns and any additional fields from log data
  const availableFields = logData?.logs && logData.logs.length > 0 
    ? [...new Set([...selectedColumns, ...Object.keys(logData.logs[0])])]
      .filter(field => field !== '_raw') // Exclude _raw as it's not useful for coloring
    : selectedColumns;

  const handleAddRule = () => {
    if (!newRule.field || (newRule.operator !== 'exists' && !newRule.value)) return;
    
    handleRuleAction(() => {
      // For 'exists' operator, we don't need a value
      const ruleToAdd = newRule.operator === 'exists' 
        ? { ...newRule, value: '' } 
        : newRule;
        
      addRule(ruleToAdd);
      
      // Reset form
      setNewRule({
        field: "",
        operator: "eq",
        value: "",
        color: ENHANCED_COLORS[0].value,
        enabled: true,
      });
      
      // Close add panel
      setIsAddPanelOpen(false);
    });
  };
  
  // Start editing a rule
  const handleStartEditRule = (rule: ColorRule) => {
    setEditingRuleId(rule.id);
    setEditingRule({
      field: rule.field,
      operator: rule.operator,
      value: rule.value,
      color: rule.color,
      enabled: rule.enabled,
    });
  };
  
  // Save edits to a rule
  const handleSaveEditRule = (id: string) => {
    if (!editingRule.field || (editingRule.operator !== 'exists' && !editingRule.value)) return;
    
    handleRuleAction(() => {
      // For 'exists' operator, we don't need a value
      const ruleToUpdate = editingRule.operator === 'exists'
        ? { ...editingRule, value: '' }
        : editingRule;
        
      updateRule(id, ruleToUpdate);
      setEditingRuleId(null);
      
      // Force immediate re-render of log elements with new color
      applyColorRulesToLogs();
    });
  };
  
  // Cancel editing
  const handleCancelEdit = () => {
    setEditingRuleId(null);
  };

  // Immediately apply color rules when actions occur
  const handleRuleAction = (action: () => void) => {
    // Execute the action first
    action();
    
    // Apply the coloring rules immediately
    applyColorRulesToLogs();
  };

  // Apply color rules to logs
  const applyColorRulesToLogs = () => {
    // Find log table elements and apply styling
    setTimeout(() => {
      try {
        // Force re-render by triggering a small state update
        const logStore = useLogResultStore.getState();
        if (logStore.logData) {
          // Re-set the same data to trigger a re-render
          logStore.setLogData({...logStore.logData});
        }
      } catch (err) {
        console.error('Error applying color rules:', err);
      }
    }, 0);
  };

  // Find color name by value
  const getColorName = (colorValue) => {
    const color = ENHANCED_COLORS.find(c => c.value === colorValue);
    return color ? color.name : 'Color';
  };
  
  // Handle color selection with live preview for new rule
  const handleNewRuleColorSelect = (color) => {
    setNewRule({ ...newRule, color });
    // For immediate preview in card background
    handleRuleAction(() => {
      // The rule card background gets updated automatically
      // with the newRule.color change above
    });
  };
  
  // Handle color selection with live preview for editing rule
  const handleEditRuleColorSelect = (color) => {
    setEditingRule({ ...editingRule, color });
    
    // For immediate preview in logs and card background
    handleRuleAction(() => {
      // The card background gets updated automatically from state
      // Don't update the actual rule until the user clicks Save
      // Just trigger a re-render for any components using these rules
    });
  };

  return (
    <TooltipProvider>
      
        <span className="">
          {/* Add Rule Section - Collapsible */}
          <Collapsible 
            open={isAddPanelOpen} 
            onOpenChange={setIsAddPanelOpen}
            className="mb-4"  
          >
            <div className="flex items-center justify-between pb-2">
              <h4 className="text-sm font-medium text-slate-600">Log Coloring Rules</h4>
              <CollapsibleTrigger asChild>
                <Button 
                  variant="outline" 
                  size="sm" 
                  className="h-8 text-xs px-2 bg-blue-600 text-primary-foreground hover:bg-blue-700"
                >
                  { isAddPanelOpen ? <X className="h-3 w-3 mr-1" /> : <Plus className="h-3 w-3 mr-1" />}
                  {isAddPanelOpen ? "Cancel" : "Add"}
                </Button>
              </CollapsibleTrigger>
            </div>
            
            <CollapsibleContent className="pt-4">
              <div className={cn("rounded-md border p-3 space-y-2", newRule.color, "bg-opacity-20")}>
                <div className="space-y-2">
                  <div className="grid grid-cols-2 gap-2">
                    <div className="space-y-1">
                      <Label htmlFor="field" className="text-xs font-medium">Field</Label>
                      <Select
                        value={newRule.field}
                        onValueChange={(value) => setNewRule({ ...newRule, field: value })}
                      >
                        <SelectTrigger 
                          id="field" 
                          className="text-xs h-7"
                          disabled={!availableFields.length}
                        >
                          <SelectValue placeholder="Select field" />
                        </SelectTrigger>
                        <SelectContent>
                          {availableFields.map((field) => (
                            <SelectItem key={field} value={field}>
                              {field}
                            </SelectItem>
                          ))}
                        </SelectContent>
                      </Select>
                    </div>
                    
                    <div className="space-y-1">
                      <Label htmlFor="operator" className="text-xs font-medium">Operator</Label>
                      <Select
                        value={newRule.operator}
                        onValueChange={(value) => setNewRule({ ...newRule, operator: value as ColorRule['operator'] })}
                      >
                        <SelectTrigger id="operator" className="text-xs h-7">
                          <SelectValue />
                        </SelectTrigger>
                        <SelectContent>
                          <SelectItem value="eq">Equals (=)</SelectItem>
                          <SelectItem value="neq">Not Equals (≠)</SelectItem>
                          <SelectItem value="contains">Contains</SelectItem>
                          <SelectItem value="exists">Exists</SelectItem>
                          <SelectItem value="regex">Regex</SelectItem>
                        </SelectContent>
                      </Select>
                    </div>
                  </div>
                  
                  <div className="grid grid-cols-[1fr,auto] gap-2 items-end">
                    <div className="space-y-1">
                      <Label htmlFor="value" className="text-xs font-medium">
                        {newRule.operator === 'exists' ? 'Value (not needed)' : 'Value'}
                      </Label>
                      <Input
                        id="value"
                        value={newRule.value}
                        onChange={(e) => setNewRule({ ...newRule, value: e.target.value })}
                        className={cn("h-7 text-xs", 
                          newRule.operator === 'exists' ? "bg-slate-50 text-slate-400" : ""
                        )}
                        placeholder={
                          newRule.operator === 'exists' ? 'No value needed' : 
                          newRule.operator === 'regex' ? 'Regular expression (e.g. error|warning)' : 
                          'Value to match'
                        }
                        disabled={newRule.operator === 'exists'}
                      />
                      {newRule.operator === 'regex' && (
                        <p className="text-[10px] text-slate-500 italic">
                          Use JavaScript RegExp syntax, e.g. error|warning, [0-9]+, etc.
                        </p>
                      )}
                    </div>
                    
                    <div>
                      <Popover>
                        <PopoverTrigger asChild>
                          <Button 
                            variant="outline" 
                            className={cn(
                              "h-7 flex items-center gap-1.5 border-slate-200 px-2", 
                              newRule.color
                            )}
                            title="Choose highlight color"
                          >
                            <Palette className="h-3.5 w-3.5 text-slate-600" />
                            <span className="text-xs">Choose Color</span>
                          </Button>
                        </PopoverTrigger>
                        <PopoverContent className="w-[280px] p-2" side="right" align="start">
                          <div className="flex items-center justify-between mb-2 pb-1 border-b">
                            <span className="text-xs font-medium">Select Highlight Color</span>
                            <div className="flex items-center gap-1.5">
                              <div className={cn("w-3 h-3 rounded-sm border", newRule.color)} />
                              <span className="text-xs font-medium">{getColorName(newRule.color)}</span>
                            </div>
                          </div>
                          <ColorPicker 
                            selectedColor={newRule.color} 
                            onColorSelect={handleNewRuleColorSelect} 
                          />
                        </PopoverContent>
                      </Popover>
                    </div>
                  </div>
                </div>
                
                <div className="pt-1 flex justify-end">
                  <Button
                    size="sm"
                    className="h-6 text-xs px-2 bg-primary hover:bg-primary/90"
                    onClick={handleAddRule}
                    disabled={!newRule.field || (newRule.operator !== 'exists' && !newRule.value)}
                  >
                    <Plus className="h-3 w-3 mr-1" />
                    Save
                  </Button>
                </div>
              </div>
            </CollapsibleContent>
          </Collapsible>
          
          {/* Existing rules */}
          <div className="space-y-2">
            <h4 className="text-sm font-medium text-slate-600 mb-2">Current Rules</h4>
            
            {colorRules.length === 0 ? (
              <div className="flex flex-col items-center justify-center py-4 px-3 bg-slate-50 rounded-md border border-dashed border-slate-200">
                <AlertCircle className="h-4 w-4 text-slate-400 mb-1" />
                <span className="text-xs text-slate-500">No coloring rules defined yet</span>
              </div>
            ) : (
              <ScrollArea className="pr-4">
                <div className="space-y-2">
                  {colorRules.map((rule) => (
                    <div 
                      key={rule.id} 
                      className={cn(
                        "rounded-md border p-3 text-sm transition-all",
                        editingRuleId === rule.id 
                          ? "bg-blue-50 border-blue-200" 
                          : rule.color,
                        editingRuleId !== rule.id && "bg-opacity-20",
                        !rule.enabled && "opacity-60"
                      )}
                    >
                      {editingRuleId === rule.id ? (
                        // Editing mode
                        <div className="space-y-2">
                          <div className="flex justify-between">
                            <span className="text-xs font-medium text-blue-600">Edit Rule</span>
                            <Button
                              size="icon"
                              variant="ghost"
                              className="h-5 w-5 text-slate-400 hover:text-slate-600"
                              onClick={handleCancelEdit}
                            >
                              <X className="h-3 w-3" />
                            </Button>
                          </div>
                          
                          <div className="grid grid-cols-2 gap-2">
                            <div className="space-y-1">
                              <Label htmlFor={`edit-field-${rule.id}`} className="text-xs font-medium">Field</Label>
                              <Select
                                value={editingRule.field}
                                onValueChange={(value) => setEditingRule({ ...editingRule, field: value })}
                              >
                                <SelectTrigger id={`edit-field-${rule.id}`} className="text-xs h-7">
                                  <SelectValue />
                                </SelectTrigger>
                                <SelectContent>
                                  {availableFields.map((field) => (
                                    <SelectItem key={field} value={field}>
                                      {field}
                                    </SelectItem>
                                  ))}
                                </SelectContent>
                              </Select>
                            </div>
                            
                            <div className="space-y-1">
                              <Label htmlFor={`edit-operator-${rule.id}`} className="text-xs font-medium">Operator</Label>
                              <Select
                                value={editingRule.operator}
                                onValueChange={(value) => setEditingRule({ ...editingRule, operator: value as ColorRule['operator'] })}
                              >
                                <SelectTrigger id={`edit-operator-${rule.id}`} className="text-xs h-7">
                                  <SelectValue />
                                </SelectTrigger>
                                <SelectContent>
                                  <SelectItem value="eq">Equals (=)</SelectItem>
                                  <SelectItem value="neq">Not Equals (≠)</SelectItem>
                                  <SelectItem value="contains">Contains</SelectItem>
                                  <SelectItem value="exists">Exists</SelectItem>
                                  <SelectItem value="regex">Regex</SelectItem>
                                </SelectContent>
                              </Select>
                            </div>
                          </div>
                          
                          <div className="grid grid-cols-[1fr,auto] gap-2 items-end">
                            <div className="space-y-1">
                              <Label htmlFor={`edit-value-${rule.id}`} className="text-xs font-medium">
                                {editingRule.operator === 'exists' ? 'Value (not needed)' : 'Value'}
                              </Label>
                              <Input
                                id={`edit-value-${rule.id}`}
                                value={editingRule.value}
                                onChange={(e) => setEditingRule({ ...editingRule, value: e.target.value })}
                                className={cn("h-7 text-xs",
                                  editingRule.operator === 'exists' ? "bg-slate-50 text-slate-400" : ""
                                )}
                                placeholder={
                                  editingRule.operator === 'exists' ? 'No value needed' : 
                                  editingRule.operator === 'regex' ? 'Regular expression (e.g. error|warning)' : 
                                  'Value'
                                }
                                disabled={editingRule.operator === 'exists'}
                              />
                              {editingRule.operator === 'regex' && (
                                <p className="text-[10px] text-slate-500 italic">
                                  Use JavaScript RegExp syntax, e.g. error|warning, [0-9]+, etc.
                                </p>
                              )}
                            </div>
                            
                            <div>
                              <Popover>
                                <PopoverTrigger asChild>
                                 
                                  <Button 
                                    variant="outline" 
                                    className={cn(
                                      "h-7 flex items-center gap-1.5 border-slate-200 px-2", 
                                      editingRule.color
                                    )}
                                    title="Choose highlight color"
                                  >
                                    <Palette className="h-3.5 w-3.5 text-slate-600" />
                                    <span className="text-xs">Choose Color</span>
                                  </Button>
                                </PopoverTrigger>
                                <PopoverContent className="w-[280px] p-2" side="right" align="start">
                                  <div className="flex items-center justify-between mb-2 pb-1 border-b">
                                    <span className="text-xs font-medium">Select Highlight Color</span>
                                    <div className="flex items-center gap-1.5">
                                      <div className={cn("w-3 h-3 rounded-sm border", editingRule.color)} />
                                      <span className="text-xs font-medium">{getColorName(editingRule.color)}</span>
                                    </div>
                                  </div>
                                  <ColorPicker 
                                    selectedColor={editingRule.color} 
                                    onColorSelect={handleEditRuleColorSelect} 
                                  />
                                </PopoverContent>
                              </Popover>
                            </div>
                          </div>
                          
                          <div className="flex justify-end space-x-2 pt-1 mt-1">
                            <Button
                              size="sm"
                              variant="outline"
                              className="h-6 text-xs px-2"
                              onClick={handleCancelEdit}
                            >
                              Cancel
                            </Button>
                            <Button
                              size="sm"
                              variant="default"
                              className="h-6 text-xs px-2 bg-blue-600 hover:bg-blue-700"
                              onClick={() => handleSaveEditRule(rule.id)}
                              disabled={!editingRule.field || (editingRule.operator !== 'exists' && !editingRule.value)}
                            >
                              <Check className="h-3 w-3 mr-1" />
                              Save
                            </Button>
                          </div>
                        </div>
                      ) : (
                        // Display mode
                        <div>
                          <div className="flex items-center justify-between mb-1">
                            <div className="flex flex-wrap items-center gap-1.5 max-w-[70%]">
                              <div className={cn("w-3 h-3 rounded-sm flex-shrink-0", rule.color)} />
                              <Badge 
                                variant="outline" 
                                className="px-1.5 py-0 h-5 text-xs font-normal border-slate-200 truncate max-w-[90px]"
                              >
                                {rule.field}
                              </Badge>
                              <span className="text-xs text-slate-500 flex-shrink-0">
                                {rule.operator === 'eq' ? '=' : 
                                 rule.operator === 'neq' ? '≠' : 
                                 rule.operator === 'contains' ? 'contains' :
                                 rule.operator === 'exists' ? 'exists' :
                                 rule.operator === 'regex' ? 'regex' : ''}
                              </span>
                              <Badge 
                                variant="secondary" 
                                className="px-1.5 py-0 h-5 text-xs font-normal bg-slate-100 truncate max-w-[90px]"
                                title={rule.value}
                              >
                                {rule.value}
                              </Badge>
                            </div>
                            
                            <div className="flex items-center space-x-1">
                              <Switch
                                checked={rule.enabled}
                                onCheckedChange={() => handleRuleAction(() => toggleRule(rule.id))}
                                className="data-[state=checked]:bg-primary"
                              />
                              
                              <Button
                                size="icon"
                                variant="ghost"
                                className="h-6 w-6 text-slate-400 hover:text-blue-600 hover:bg-blue-50"
                                onClick={() => handleStartEditRule(rule)}
                              >
                                <Pencil className="h-3 w-3" />
                              </Button>
                              
                              <Button
                                size="icon"
                                variant="ghost"
                                className="h-6 w-6 text-slate-400 hover:text-red-600 hover:bg-red-50"
                                onClick={() => handleRuleAction(() => deleteRule(rule.id))}
                              >
                                <Trash2 className="h-3 w-3" />
                              </Button>
                            </div>
                          </div>
                        </div>
                      )}
                    </div>
                  ))}
                </div>
              </ScrollArea>
            )}
          </div>
        </span>
     
    </TooltipProvider>
  );
}; 