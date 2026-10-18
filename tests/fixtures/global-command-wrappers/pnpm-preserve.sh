#!/bin/sh
basedir=$(dirname "$(echo "$0" | sed -e 's,\\,/,g')")

case `uname` in
    *CYGWIN*) basedir=`cygpath -w "$basedir"`;;
esac

if [ -x "$basedir/node" ]; then
  exec "$basedir/node" --preserve-symlinks "$basedir/__TARGET__" "$@"
else
  exec node --preserve-symlinks "$basedir/__TARGET__" "$@"
fi
