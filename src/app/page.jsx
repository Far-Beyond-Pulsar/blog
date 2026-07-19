import { getBlogIndex } from "@/utils/blog";
import BlogHomeClient from "./BlogHomeClient";

export const metadata = {
  title: "Pulsar Blog",
  description:
    "What we're building, breaking, and fixing inside the Pulsar game engine — renderer deep dives, Rust patterns, and everything we learn along the way.",
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
