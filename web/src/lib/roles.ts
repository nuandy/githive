// Review roles in words.

/** Who votes as a role: "reviewer" for a general review, "security reviewer" for any other role. */
export const roleName = (role: string) => (role === "review" ? "reviewer" : `${role} reviewer`);
