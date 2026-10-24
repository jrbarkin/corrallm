# The official Node image installs the pinned runtime in /usr/local/bin. Login shells may
# replace Docker's PATH in /etc/profile; retain the runtime for the non-root build user too.
case ":${PATH:-}:" in
  *:/usr/local/bin:*) ;;
  *) PATH="/usr/local/bin${PATH:+:$PATH}" ;;
esac
export PATH
