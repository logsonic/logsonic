import React, { useState } from "react";
import {
  Popover,
  PopoverContent,
  PopoverTrigger,
} from "@/components/ui/popover";
import { Button } from "@/components/ui/button";
import { X, Copy, Check } from "lucide-react";
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs";

// Helper component for code examples with copy button
function CodeExample({ content }: { content: string }) {
  const [copied, setCopied] = useState(false);

  const copyToClipboard = () => {
    navigator.clipboard.writeText(content.replace(/<br \/>/g, "\n"));
    setCopied(true);
    setTimeout(() => setCopied(false), 2000);
  };

  return (
    <div className="bg-gray-50 border border-gray-200 p-3 rounded-lg text-sm relative group hover:border-gray-300 transition-colors">
      <div 
        className="absolute right-2 top-2 opacity-0 group-hover:opacity-100 transition-opacity"
      >
        <Button 
          variant="ghost" 
          size="icon" 
          className="h-6 w-6 bg-white hover:bg-gray-50 rounded-md shadow-sm border border-gray-200" 
          onClick={copyToClipboard}
          title="Copy to clipboard"
        >
          {copied ? <Check size={14} className="text-green-600" /> : <Copy size={14} />}
        </Button>
      </div>
      <code dangerouslySetInnerHTML={{ __html: content }} className="text-gray-800" />
    </div>
  );
}

export function QueryHelperPopover({ trigger }: { trigger: React.ReactNode }) {
  const [open, setOpen] = useState(false);

  return (
    <Popover open={open} onOpenChange={setOpen}>
      <PopoverTrigger asChild>{trigger}</PopoverTrigger>
      <PopoverContent 
        className="w-[600px] max-h-[600px] overflow-y-auto p-0 border-0 shadow-2xl bg-white rounded-xl" 
        align="start" 
        side="bottom"
        alignOffset={20}
      >
        <div className="p-6 border-b bg-gradient-to-r from-blue-50 to-white">
          <div className="flex justify-between items-start">
            <div className="space-y-1">
              <h2 className="text-xl font-semibold text-gray-900">Query Syntax</h2>
              <p className="text-sm text-gray-600">
                Build powerful search queries using <a href="https://blevesearch.com/docs/Query-String-Query/" target="_blank" rel="noopener noreferrer" className="text-blue-600 hover:underline font-medium">Bleve Query documentation</a>
              </p>
            </div>
            <Button 
              variant="ghost" 
              size="icon" 
              onClick={() => setOpen(false)}
              className="h-8 w-8 rounded-full hover:bg-gray-100"
            >
              <X size={18} className="text-gray-500" />
            </Button>
          </div>
        </div>

        <Tabs defaultValue="basics" className="w-full">
          <TabsList className="w-full justify-start px-6 py-3 bg-gray-50/50 border-b">
            <TabsTrigger value="basics" className="data-[state=active]:bg-white data-[state=active]:shadow-sm">Basics</TabsTrigger>
            <TabsTrigger value="operators" className="data-[state=active]:bg-white data-[state=active]:shadow-sm">Operators</TabsTrigger>
            <TabsTrigger value="regex" className="data-[state=active]:bg-white data-[state=active]:shadow-sm">Regex</TabsTrigger>
            <TabsTrigger value="ranges" className="data-[state=active]:bg-white data-[state=active]:shadow-sm">Ranges</TabsTrigger>
            <TabsTrigger value="advanced" className="data-[state=active]:bg-white data-[state=active]:shadow-sm">Advanced</TabsTrigger>
          </TabsList>

          <TabsContent value="basics" className="p-6 space-y-6">
            <div className="space-y-3">
              <h3 className="font-medium text-gray-900">Free Text Search</h3>
              <p className="text-sm text-gray-600">
                Search across any field with free text search.
              </p>
              <CodeExample content="Error" />
            </div>

            <div className="space-y-3">
              <h3 className="font-medium text-gray-900">Exact Match</h3>
              <p className="text-sm text-gray-600">
                Use quotes to search for exact phrases.
              </p>
              <CodeExample content="&quot;connection timeout&quot;" />
            </div>

            <div className="space-y-3">
              <h3 className="font-medium text-gray-900">Field Scoping</h3>
              <p className="text-sm text-gray-600">
                Prefix with column name and colon to search only in specific fields.
              </p>
              <CodeExample content="level:error" />
            </div>
          </TabsContent>

          <TabsContent value="operators" className="p-6 space-y-6">
            <div className="space-y-3">
              <h3 className="font-medium text-gray-900">AND Operators</h3>
              <p className="text-sm text-gray-600">
                Prefix with a + sign to logically AND all terms in the query.
              </p>
              <CodeExample content="+error +level:error +timeout" />
              <p className="text-sm text-gray-600">Will only return documents that contain error AND level:error AND timeout.</p>
            </div>

            <div className="space-y-3">
              <h3 className="font-medium text-gray-900">OR Operators</h3>
              <p className="text-sm text-gray-600">
                By default all terms are ORed together.
              </p>
              <CodeExample content="error  level:warning" />
              <p className="text-sm text-gray-600">Will return documents that contain either error or level:warning.</p>
            </div>

            <div className="space-y-3">
              <h3 className="font-medium text-gray-900">NOT Operators</h3>
              <p className="text-sm text-gray-600">
                Prefix with a - sign to exclude terms from the query.
              </p>
              <CodeExample content="error -network" />
              <p className="text-sm text-gray-600">Will return documents that contain error but not network.</p>
            </div>
          </TabsContent>

          <TabsContent value="regex" className="p-6 space-y-6">
            <div className="space-y-3">
              <h3 className="font-medium text-gray-900">Regular Expressions</h3>
              <p className="text-sm text-gray-600">
                Use forward slashes to enclose regex patterns.
              </p>
              <CodeExample content="/light (beer|wine)/" />
              <p className="text-sm text-gray-600">Will return documents that contain light followed by either beer or wine.</p>
            </div>
          </TabsContent>

          <TabsContent value="ranges" className="p-6 space-y-6">
            <div className="space-y-3">
              <h3 className="font-medium text-gray-900">Numeric Ranges</h3>
              <p className="text-sm text-gray-600">
                Use comparison operators for numeric fields.
              </p>
              <CodeExample content={`status:>400 - Status codes greater than 400<br />latency:>=100 - Latency greater than or equal to 100<br />memory:<1024 - Memory less than 1024`} />
            </div>
          </TabsContent>

          <TabsContent value="advanced" className="p-6 space-y-6">
            <div className="space-y-3">
              <h3 className="font-medium text-gray-900">Escaping Special Characters</h3>
              <p className="text-sm text-gray-600">
                Use backslash to escape: <code className="bg-gray-100 px-1.5 py-0.5 rounded text-gray-800">+-=&|{`>`}!(){}[]^\"~*?:\/</code> (includes space)
              </p>
              <CodeExample content="status\\:200" />
              <p className="text-sm text-gray-600">Will return documents that contain status:200.</p>
            </div>
          </TabsContent>
        </Tabs>
      </PopoverContent>
    </Popover>
  );
} 