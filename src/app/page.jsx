import { getBlogIndex } from "@/utils/blog";
import BlogHomeClient from "./BlogHomeClient";

export const metadata = {
  title: "Pulsar Blog",
  description:
    "Engineering updates, deep dives, and release notes from the Pulsar game engine team.",
};

const BASE = process.env.NEXT_PUBLIC_CUSTOM_BASE_PATH || "";
const VISIBLE_TAGS = 10;

export default function BlogHome() {
  const { posts, allTags, tagFreq, allAuthors, total } = getBlogIndex();

  return (
    <BlogHomeClient
      posts={posts}
      allTags={allTags}
      tagFreq={tagFreq}
      allAuthors={allAuthors || []}
      total={total}
      base={BASE}
      visibleTags={VISIBLE_TAGS}
    />
  );
}
