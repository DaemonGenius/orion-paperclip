import type { Meta, StoryObj } from "@storybook/react-vite";
import { TaskChatUxLab } from "@/pages/TaskChatUxLab";
import { InviteUxLab } from "@/pages/InviteUxLab";
import { RunTranscriptUxLab } from "@/pages/RunTranscriptUxLab";

function StoryFrame({ children }: { children: React.ReactNode }) {
  return (
    <div className="paperclip-story">
      <main className="paperclip-story__inner">{children}</main>
    </div>
  );
}

const meta = {
  title: "UX Labs/Converted Test Pages",
  parameters: {
    docs: {
      description: {
        component:
          "The former in-app UX test routes are represented here as Storybook stories so fixture-backed review surfaces stay out of production routing.",
      },
    },
  },
} satisfies Meta;

export default meta;

type Story = StoryObj<typeof meta>;

export const TaskChatReviewSurface: Story = {
  name: "Task Chat Review Surface",
  render: () => (
    <StoryFrame>
      <TaskChatUxLab />
    </StoryFrame>
  ),
  parameters: {
    docs: {
      description: {
        story:
          "Exercises assistant-ui task chat states: timeline events, live run stream, queued message, feedback controls, submitting bubble, empty state, and disabled composer.",
      },
    },
  },
};

export const RunTranscriptFixtures: Story = {
  name: "Run Transcript Fixtures",
  render: () => (
    <StoryFrame>
      <RunTranscriptUxLab />
    </StoryFrame>
  ),
  parameters: {
    docs: {
      description: {
        story:
          "Exercises run transcript presentation across the run detail page, task live widget, and dashboard card density.",
      },
    },
  },
};

export const InviteAndAccessFlow: Story = {
  name: "Invite And Access Flow",
  render: () => (
    <StoryFrame>
      <InviteUxLab />
    </StoryFrame>
  ),
  parameters: {
    docs: {
      description: {
        story:
          "Exercises invitation and access UX states with fixture-backed role choices, landing frames, history, and failure treatments.",
      },
    },
  },
};
