#!/usr/bin/env python3
"""在伺服器上建立第一個管理員帳號。

後台沒有「註冊」功能，第一個帳號只能從伺服器端建立。這是刻意的：任何對外開放的
註冊入口都等於讓陌生人拿到上傳知識庫檔案的權限，而知識庫的內容會餵給 AI。

用法（在伺服器的 repo 目錄下）：

    docker compose run --rm chat python scripts/create_admin.py

會互動詢問帳號與密碼。密碼不會顯示在畫面上，也不會進入 shell 歷史。

非互動（例如寫在自動化腳本裡）：

    printf '%s' "$PASSWORD" | docker compose run --rm -T chat \\
      python scripts/create_admin.py --username admin --password-stdin

其他選項：

    --role editor      建立一般編輯者而非管理員
    --list             列出現有帳號後結束
    --allow-additional 已經有管理員時仍要再建一個
"""

from __future__ import annotations

import argparse
import getpass
import sys
from pathlib import Path

# 讓「python scripts/create_admin.py」在沒設 PYTHONPATH 時也能 import app.*
sys.path.insert(0, str(Path(__file__).resolve().parent.parent))

from app.admin import auth  # noqa: E402


def read_password(confirm: bool = True) -> str:
    """從 TTY 讀密碼。

    刻意不接受 --password 這種直接把密碼寫在命令列的參數：那會留在 shell 歷史、
    也會出現在同一台機器上任何人都看得到的行程列表裡。
    """
    while True:
        first = getpass.getpass("設定密碼（至少 12 字元，輸入時不會顯示）：")
        try:
            auth.validate_password(first)
        except auth.AuthError as error:
            print(f"  {error}", file=sys.stderr)
            continue
        if not confirm:
            return first
        second = getpass.getpass("再輸入一次確認：")
        if first != second:
            print("  兩次輸入不一致，請重試。", file=sys.stderr)
            continue
        return first


def print_users() -> None:
    users = auth.list_users()
    if not users:
        print("目前沒有任何帳號。")
        return
    print(f"目前共 {len(users)} 個帳號：")
    print(f"  {'帳號':<20} {'角色':<8} {'狀態':<8} {'最後登入'}")
    for user in users:
        state = "停用" if user["disabled"] else ("鎖定" if user["locked"] else "正常")
        print(f"  {user['username']:<20} {user['role']:<8} {state:<8} {user['last_login'] or '—'}")


def main() -> int:
    parser = argparse.ArgumentParser(description="建立後台管理員帳號")
    parser.add_argument("--username", help="帳號名稱；省略則互動詢問")
    parser.add_argument("--role", default="admin", choices=list(auth.ROLES))
    parser.add_argument(
        "--password-stdin",
        action="store_true",
        help="從標準輸入讀密碼（給自動化用；互動時請不要加這個）",
    )
    parser.add_argument("--list", action="store_true", help="列出現有帳號後結束")
    parser.add_argument(
        "--unlock",
        metavar="USERNAME",
        help="解除某個帳號的登入鎖定（連續失敗會鎖 15 分鐘，這個可以立刻解開）",
    )
    parser.add_argument(
        "--reset-password",
        metavar="USERNAME",
        help="重設某個帳號的密碼；忘記唯一管理員密碼時的救援路徑",
    )
    parser.add_argument(
        "--allow-additional",
        action="store_true",
        help="已存在可用的管理員時仍要建立新帳號",
    )
    args = parser.parse_args()

    print(f"帳號檔位置：{auth.USERS_PATH}")

    try:
        if args.list:
            print_users()
            return 0

        if args.unlock:
            # actor 用帳號自己：這條路徑是從伺服器端執行的，本來就等同最高權限，
            # 而 update_user 的「不能改自己」限制只針對角色與停用，unlock 不受影響。
            auth.update_user(args.unlock, actor=args.unlock, unlock=True)
            print(f"已解除 {args.unlock} 的鎖定。")
            return 0

        if args.reset_password:
            target = args.reset_password
            if args.password_stdin:
                password = sys.stdin.read().rstrip("\n")
                auth.validate_password(password)
            else:
                if not sys.stdin.isatty():
                    print("沒有可用的終端機，請改用 --password-stdin。", file=sys.stderr)
                    return 1
                password = read_password()
            auth.update_user(target, actor=target, password=password)
            print(f"已重設 {target} 的密碼，該帳號目前的登入狀態已全部失效。")
            return 0

        already = auth.has_admin()
        if already and args.role == "admin" and not args.allow_additional:
            print(
                "已經有可用的管理員帳號了。\n"
                "  要新增帳號請直接登入後台的「帳號管理」頁面操作。\n"
                "  真的要從指令列再建一個，請加上 --allow-additional。",
                file=sys.stderr,
            )
            print_users()
            return 1

        username = args.username or input("帳號名稱（3-32 字元，英數字與 . _ -）：")
        username = auth.normalise_username(username)

        if args.password_stdin:
            password = sys.stdin.read().rstrip("\n")
            auth.validate_password(password)
        else:
            if not sys.stdin.isatty():
                print(
                    "沒有可用的終端機來輸入密碼。\n"
                    "  互動執行請確認有加 -it，或改用 --password-stdin。",
                    file=sys.stderr,
                )
                return 1
            password = read_password()

        user = auth.create_user(username, password, role=args.role, created_by="scripts/create_admin.py")

    except auth.AuthError as error:
        print(f"失敗：{error}", file=sys.stderr)
        return 1
    except (KeyboardInterrupt, EOFError):
        print("\n已取消。", file=sys.stderr)
        return 130

    print(f"\n已建立 {user['role']} 帳號：{user['username']}")
    print("接著到 /#/admin 登入。")
    for warning in auth.startup_warnings():
        print(f"注意：{warning}", file=sys.stderr)
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
