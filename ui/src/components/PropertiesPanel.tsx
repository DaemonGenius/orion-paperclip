import { X } from "lucide-react";
import { usePanel } from "../context/PanelContext";
import { Button } from "@/components/ui/button";
import { ScrollArea } from "@/components/ui/scroll-area";

export function PropertiesPanel() {
  const { panelContent, panelVisible, setPanelVisible } = usePanel();

  if (!panelContent) return null;

  return (
    <aside
      className="hidden border-l border-border bg-card md:flex md:w-[min(400px,calc(100vw-4.5rem))] lg:w-[min(440px,calc(100vw-4.5rem))] xl:w-[min(480px,calc(100vw-4.5rem))] flex-col shrink-0 overflow-hidden transition-[width,opacity] duration-200 ease-in-out h-full"
      style={{ width: panelVisible ? undefined : 0, opacity: panelVisible ? 1 : 0 }}
    >
      <div className="flex-1 flex flex-col min-h-0 md:w-[min(400px,calc(100vw-4.5rem))] lg:w-[min(440px,calc(100vw-4.5rem))] xl:w-[min(480px,calc(100vw-4.5rem))]">
        <div className="flex items-center justify-between px-4 py-2 border-b border-border">
          <span className="text-sm font-medium">Properties</span>
          <Button variant="ghost" size="icon-xs" onClick={() => setPanelVisible(false)}>
            <X className="h-4 w-4" />
          </Button>
        </div>
        <ScrollArea className="flex-1">
          <div className="p-4">{panelContent}</div>
        </ScrollArea>
      </div>
    </aside>
  );
}
