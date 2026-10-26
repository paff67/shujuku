/** Editable defaults are saved in the native sheet Note, never a second prompt preset. */
export const ORIGINAL_GUIDE_NOTE_ACU = '[原著纪要业务规则 v2]\n只追加纪要，不修改或删除既有行、结构或其他表。只记录所给正文中已发生事实，不编造时间、事件或对白。每个填写批次至少追加一条非空纪要，AM 编码不可重复。\n按剧情顺序保留有价值的 NPC 原话并标明说话者，不同 NPC 分开；玩家直接引语每条最多一句，其余行为客观概括。区分正常亲密互动与主从压迫，不把普通互动改写为精神支配、剥夺反抗或屈服。';
export function originalGuideNote_ACU(note: string): string { return String(note || '').includes('[原著纪要业务规则 v2]') ? note : [note, ORIGINAL_GUIDE_NOTE_ACU].filter(Boolean).join('\n\n'); }
