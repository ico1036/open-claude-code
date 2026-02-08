/**
 * ReplyTracker - Tracks whether the agent actually sent a reply.
 *
 * Unlike OpenClaw's full ReplyDispatcher with send chains, we only need
 * a simple counter because Agent SDK's send_message MCP tool already
 * sends directly via messageRouter.send(). We just track "did it happen?"
 */

export type ReplyTracker = {
  /** Record that a message was successfully sent */
  recordSend: () => void;
  /** How many messages were sent */
  getSentCount: () => number;
  /** Whether at least one message was sent */
  hasSent: () => boolean;
};

export function createReplyTracker(): ReplyTracker {
  let count = 0;

  return {
    recordSend() {
      count++;
    },
    getSentCount() {
      return count;
    },
    hasSent() {
      return count > 0;
    },
  };
}
